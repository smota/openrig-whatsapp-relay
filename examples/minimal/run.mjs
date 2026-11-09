import * as core from "@openrig-whatsapp-relay/core";
import { runExample } from "./index.mjs";

const result = await runExample(core);
console.log(`Outbound accepted: ${result.accepted.status}`);
console.log(`Replay deduplicated: ${result.replayed.body.deduplicated}`);
console.log(`Transport messages: ${result.sent.length}`);
console.log(`Gateway answer: ${result.answers[0].text}`);
console.log(`Custody status: ${result.status}`);
