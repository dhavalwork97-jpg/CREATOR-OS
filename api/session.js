// Expose the owner session-check endpoint as an explicit Vercel function.
import handler from "./[...path].mjs";

export default handler;
