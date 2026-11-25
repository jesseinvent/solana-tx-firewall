// Fails fast with a clear message on Node versions too old for the Tailwind v4 toolchain.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error(
    `\n✖ Node ${process.versions.node} is too old for this project (needs >= 20.19, .nvmrc pins 24).\n` +
      `  Run:  nvm use   (or: nvm alias default 24)\n`,
  );
  process.exit(1);
}
