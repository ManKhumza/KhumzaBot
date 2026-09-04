import { tool } from "@opencode-ai/plugin"
import path from "node:path"

export default tool({
  description:
    "Run the independent NOC AI Assistant compile, test, resource, and build gate; returns structured status and bounded output.",
  args: {
    package: tool.schema
      .boolean()
      .optional()
      .describe("Also create and verify Windows release packages after ordinary checks pass"),
  },
  async execute(args, context) {
    const script = path.join(context.worktree, "scripts", "quality-gate.ps1")
    const command = ["pwsh.exe", "-NoProfile", "-File", script]
    if (args.package) command.push("-Package")

    const process = Bun.spawn(command, {
      cwd: context.worktree,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ])
    const limit = 12_000
    return JSON.stringify(
      {
        passed: exitCode === 0,
        exitCode,
        report: path.join(context.worktree, ".artifacts", "nemotron", "quality-report.json"),
        outputTail: (stdout + "\n" + stderr).slice(-limit),
      },
      null,
      2,
    )
  },
})
