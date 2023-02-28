import "https://deno.land/std@0.178.0/dotenv/load.ts";

import { debug as createLogger } from "https://deno.land/x/debug@0.2.0/mod.ts";
import { program } from "npm:commander@10.0.0";
// @deno-types="npm:@types/cron@2.0.0"
import { CronJob } from "npm:cron@2.2.0";
import LRUCache from "npm:lru-cache@7.17.0";

const PREVIOUS_IP_ADDRESS = "previous-ip-address";

const cache = new LRUCache({ max: 10 });
const log = createLogger("cdu");

async function getCurrentIp(): Promise<string> {
  const res = await fetch("https://api.ipify.org");
  return res.text();
}

async function getZoneId(
  email: string,
  apiKey: string,
  zoneName: string,
): Promise<string> {
  const url = new URL("https://api.cloudflare.com/client/v4/zones");
  url.searchParams.set("name", zoneName);
  const res = await fetch(url.toString(), {
    headers: {
      "X-Auth-Email": email,
      "X-Auth-Key": apiKey,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    log("Cloudflare response: %d %s", res.status, await res.text());
    throw new Error(`failed to find zone ${zoneName}`);
  }
  const data = await res.json();
  log("Cloudflare response: %j", data);
  return data?.result[0]?.id;
}

async function getRecordIds(
  email: string,
  apiKey: string,
  zoneId: string,
  recordNames: string[],
): Promise<Record<string, string>> {
  const idMap: Record<string, string> = {};
  const promises: Promise<void>[] = [];
  for (const recordName of recordNames) {
    const p = async (): Promise<void> => {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
      );
      url.searchParams.set("name", recordName);
      url.searchParams.set("type", "A");
      const res = await fetch(url.toString(), {
        headers: {
          "X-Auth-Email": email,
          "X-Auth-Key": apiKey,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) {
        log("Cloudflare response: %d %s", res.status, await res.text());
        throw new Error(`failed to find record ${recordName}`);
      }
      const data = await res.json();
      log("Cloudflare response: %j", data);
      idMap[recordName] = data?.result[0]?.id;
    };
    promises.push(p());
  }
  await Promise.all(promises);
  return idMap;
}

function updateDNSRecord(
  email: string,
  apiKey: string,
  zoneId: string,
  recordIds: string[],
  newIpAddress: string,
): Promise<void[]> {
  const body = JSON.stringify({ type: "A", content: newIpAddress });
  const promises: Promise<void>[] = [];
  for (const recordId of recordIds) {
    const p = async (): Promise<void> => {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`,
      );
      const res = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          "X-Auth-Email": email,
          "X-Auth-Key": apiKey,
          "Content-Type": "application/json",
        },
        body,
      });
      if (!res.ok) {
        log("Cloudflare response: %d %s", res.status, await res.text());
        throw new Error(`failed to update DNS record ${recordId}`);
      }
      const data = await res.json();
      log("Cloudflare response: %j", data);
      log("update zone %s record %s with %s", zoneId, recordId, newIpAddress);
    };
    promises.push(p());
  }
  return Promise.all(promises);
}

program.requiredOption(
  "-k, --api-key <apiKey>",
  "Cloudflare API key",
  Deno.env.get("CF_API_KEY"),
).requiredOption(
  "-e, --email <email>",
  "Cloudflare e-mail address",
  Deno.env.get("CF_EMAIL"),
).requiredOption(
  "-z, --zone <zone>",
  "Cloudflare zone name",
  Deno.env.get("CF_ZONE"),
).requiredOption(
  "-r, --records <records>",
  "Cloudflare record names",
  Deno.env.get("CF_RECORDS"),
).option("-c, --cron <cron>", "Cron", "0 */5 * * * *");

async function main() {
  program.parse();

  const opts = program.opts();
  log("command line arguments: %j", opts);
  const { apiKey, cron, email, records, zone } = opts;

  if (!apiKey || !email || !records || !zone) {
    throw new Error("apiKey, email, records, and zone are required");
  }

  const job = new CronJob(cron, async () => {
    const currentIp = await getCurrentIp();
    const previousIp = cache.get(PREVIOUS_IP_ADDRESS);
    log(
      "current IP address: %s, previous IP address: %s",
      currentIp,
      previousIp,
    );

    if (previousIp === currentIp) {
      log("IP address doesn't change, skip");
      return;
    }
    cache.set(PREVIOUS_IP_ADDRESS, currentIp);

    const zoneId = await getZoneId(email, apiKey, zone);
    log("zone ID: %s", zoneId);
    if (!zoneId) {
      throw new Error(`${zone} doesn't exist`);
    }

    const recordNames = records.split(",");
    const recordIds = await getRecordIds(
      email,
      apiKey,
      zoneId,
      recordNames,
    );
    log("record IDs: %j", recordIds);
    for (const recordName of recordNames) {
      if (!recordIds[recordName]) {
        throw new Error(`${recordName} doesn't exist`);
      }
    }

    await updateDNSRecord(
      email,
      apiKey,
      zoneId,
      Object.values(recordIds),
      currentIp,
    );
  });

  log("start cron job with cron: %s", cron);
  job.start();
}

main().catch(console.error);
