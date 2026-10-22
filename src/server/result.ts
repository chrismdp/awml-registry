export type Refusal = { ok: false; status: 400 | 401 | 403 | 404 | 422; errors: string[] };
export type Result<T> = ({ ok: true } & T) | Refusal;

export const refuse = (status: Refusal["status"], ...errors: string[]): Refusal => ({
  ok: false,
  status,
  errors,
});
