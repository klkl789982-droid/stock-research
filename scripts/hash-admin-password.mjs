import { hashAdminPassword } from "../lib/admin-auth.mjs";

// Run personally in a terminal; password is never echoed or passed in argv.
if (!process.stdin.isTTY) throw new Error("Run this command in an interactive terminal.");
process.stdout.write("Administrator password (16+ characters, hidden): ");
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
let password = "";
process.stdin.on("data", async (text) => {
  if (text.includes("\u0003")) { process.stdin.setRawMode(false); process.exit(1); }
  for (const char of text) {
    if (char === "\r" || char === "\n") {
      process.stdin.setRawMode(false); process.stdin.pause();
      try { process.stdout.write(`\nTB_ADMIN_PASSWORD_HASH=${await hashAdminPassword(password)}\n`); }
      catch { process.stderr.write("\nPassword must be at least 16 characters, maximum 1024 bytes.\n"); process.exitCode = 1; }
      password = ""; return;
    }
    if (char === "\u007f" || char === "\b") password = password.slice(0, -1);
    else if (password.length < 1024 && char >= " ") password += char;
  }
});
