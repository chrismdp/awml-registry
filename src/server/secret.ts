// BETTER_AUTH_SECRET signs every session and sign-in link, so whoever knows
// it can sign in as anyone. The registry will not start with a weak one.

const HOW = "Set it to at least 32 random characters: openssl rand -base64 32 makes one.";

function secretProblem(secret: string | undefined) {
  if (!secret) return `BETTER_AUTH_SECRET is not set. ${HOW}`;
  if (secret === "change-me") return `BETTER_AUTH_SECRET is still change-me, the example's value. ${HOW}`;
  if (secret.length < 32) return `BETTER_AUTH_SECRET is only ${secret.length} characters long. ${HOW}`;
}

// Stops the server, saying why, when the secret is missing, the example's or short.
export function refuseWeakSecret() {
  const problem = secretProblem(process.env.BETTER_AUTH_SECRET);
  if (!problem) return;
  // An error thrown while Next.js starts only gets logged, and the server goes
  // on answering every request with a 500, so stop it instead.
  console.error(`[awml] The registry will not start. ${problem}`);
  process.exit(1);
}
