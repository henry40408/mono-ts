const res = await fetch("https://api.ipify.org");
console.debug(await res.text());
