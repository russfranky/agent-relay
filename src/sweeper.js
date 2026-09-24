import { isExpired } from "./db.js";

export async function sweepExpired(db, config) {
  const boxes = await db.prepare("SELECT * FROM boxes").all();
  let removed = 0;
  const clearReplies = db.prepare("UPDATE messages SET reply_to = NULL WHERE box_id = ?");
  const delMsgs = db.prepare("DELETE FROM messages WHERE box_id = ?");
  const delBox = db.prepare("DELETE FROM boxes WHERE id = ?");
  const addTomb = db.prepare(
    "INSERT OR REPLACE INTO tombstones (id, deleted_at) VALUES (?, ?)"
  );
  const tx = db.transaction(async () => {
    for (const box of boxes) {
      if (isExpired(box, config.retentionDays)) {
        await clearReplies.run(box.id);
        await delMsgs.run(box.id);
        await addTomb.run(box.id, new Date().toISOString());
        await delBox.run(box.id);
        removed++;
      }
    }
  });
  await tx();

  const cutoff = new Date(
    Date.now() - config.retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  await db.prepare("DELETE FROM tombstones WHERE deleted_at < ?").run(cutoff);
  return removed;
}

export function startSweeper(db, config, log) {
  const id = setInterval(() => {
    sweepExpired(db, config).then(
      (n) => {
        if (n && log) log.info({ swept: n }, "sweeper removed expired boxes");
      },
      (err) => {
        if (log) log.error({ err: err.message }, "sweeper failed");
      }
    );
  }, config.sweepIntervalMs);
  if (typeof id.unref === "function") id.unref();
  return () => clearInterval(id);
}
