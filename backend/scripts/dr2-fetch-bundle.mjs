// Fetch a finished prover job's bundle from the gateway and print one field (seal|image_id|journal|
// journal_digest), or a summary. Usage: node dr2-fetch-bundle.mjs <job_id> [field]
const GATEWAY = process.env.GATEWAY || "https://prover.wazowsky.id";
const [jobId, field] = process.argv.slice(2);
const r = await fetch(`${GATEWAY}/prove/${jobId}`);
const j = await r.json();
if (j.status !== "done" || !j.bundle) {
  console.error(`job ${jobId} not done: status=${j.status} by=${j.by} err=${j.error || "-"}`);
  process.exit(1);
}
const b = j.bundle;
if (field) {
  process.stdout.write(b[field]);
} else {
  const jr = b.journal;
  console.error(`image_id     = ${b.image_id}`);
  console.error(`room_id      = ${jr.slice(10, 74)}`);
  console.error(`eligible_root= ${jr.slice(74, 138)}`);
  console.error(`nullifier    = ${jr.slice(138, 202)}`);
  console.error(`accessor     = ${jr.slice(202, 266)}`);
  console.error(`recipient    = ${jr.slice(266, 330)}`);
}
