import "https://deno.land/std@0.178.0/dotenv/load.ts";

import * as flags from "https://deno.land/std@0.178.0/flags/mod.ts";
import { debug as createLogger } from "https://deno.land/x/debug@0.2.0/mod.ts";
import cron from "npm:cron@2.2.0";
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

function getRecordIds(
  email: string,
  apiKey: string,
  zoneId: string,
  recordNames: string[],
): Promise<string[]> {
  const promises: Promise<string>[] = [];
  for (const recordName of recordNames) {
    const p = async (): Promise<string> => {
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
      return data?.result[0]?.id;
    };
    promises.push(p());
  }
  return Promise.all(promises);
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

async function main() {
  const parsed = flags.parse(Deno.args);
  log("command line arguments: %j", parsed);

  const config = {
    apiKey: parsed.apiKey || Deno.env.get("CF_API_KEY"),
    cron: parsed.cron || Deno.env.get("CRON") || "0 */5 * * * *",
    email: parsed.email || Deno.env.get("CF_EMAIL"),
    records: parsed.records || Deno.env.get("CF_RECORDS"),
    zone: parsed.zone || Deno.env.get("CF_ZONE"),
  };
  log("configuration: %j", config);

  if (!config.apiKey || !config.email || !config.records || !config.zone) {
    throw new Error("apiKey, email, records, and zone are required");
  }

  const job = new cron.CronJob(config.cron, async () => {
    const currentIp = await getCurrentIp();
    log("current IP address: %s", currentIp);

    if (cache.get(PREVIOUS_IP_ADDRESS) === currentIp) {
      log("IP address doesn't change, skip");
      return;
    }
    cache.set(PREVIOUS_IP_ADDRESS, currentIp);

    const zoneId = await getZoneId(config.email, config.apiKey, config.zone);
    log("zone ID: %s", zoneId);

    const recordNames = config.records.split(",");
    const recordIds = await getRecordIds(
      config.email,
      config.apiKey,
      zoneId,
      recordNames,
    );
    log("record IDs: %j", recordIds);

    await updateDNSRecord(
      config.email,
      config.apiKey,
      zoneId,
      recordIds,
      currentIp,
    );
  });

  log("start cron job with cron: %s", config.cron);
  job.start();
}

main().catch(console.error);
