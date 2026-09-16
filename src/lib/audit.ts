import { execute } from '@/db/client';

export async function logAudit(entry: {
  user_id: number | null;
  action: string;
  entity_type?: string | null;
  entity_id?: number | null;
  previous_value?: string | null;
  new_value?: string | null;
}): Promise<void> {
  await execute(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, previous_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.user_id, entry.action, entry.entity_type ?? null, entry.entity_id ?? null, entry.previous_value ?? null, entry.new_value ?? null]
  );
}
