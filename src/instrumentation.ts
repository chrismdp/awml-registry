// Next.js runs register() once as the server starts, before it answers
// anything. The check is imported only on Node.js, since it stops the process.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { refuseWeakSecret } = await import("@/server/secret");
  refuseWeakSecret();
}
