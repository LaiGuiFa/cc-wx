export type ServerCommand = "start" | "help";

export function parseServerCommand(args: string[]): ServerCommand {
  if (args.length === 0) {
    return "start";
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return "help";
  }
  throw new Error(`Unknown argument: ${args.join(" ")}. Run cc-wx --help.`);
}

export function serverHelpText(): string {
  return [
    "Usage: cc-wx",
    "",
    "Starts the local cc-wx Web service.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting the service",
    "",
    "Environment:",
    "  CC_WX_PORT       Local Web port (default: 8787)",
    "  CC_WX_STATE_DIR  State directory (default: ~/.cc-wx)",
    "  CC_WX_OPEN=0     Do not open the browser automatically"
  ].join("\n");
}
