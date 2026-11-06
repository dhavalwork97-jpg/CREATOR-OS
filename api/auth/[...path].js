// Vercel's explicit auth catch-all ensures Neon Auth proxy requests are routed
// independently from the application's general API catch-all.
// The shared handler retains owner-email and setup-secret enforcement.
import handler from "../[...path].mjs";

export default handler;
