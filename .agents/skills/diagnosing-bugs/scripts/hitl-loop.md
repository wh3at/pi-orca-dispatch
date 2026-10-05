# Human-in-the-loop reproduction

Copy `hitl-loop.template.sh`, replace the example steps and final output fields, and run the copy with Bash. The agent runs the script while the user follows its prompts.

- `step "Instruction"` displays an action and waits for Enter.
- `capture VARIABLE "Question"` reads an observation into the named variable.
- The final `printf` calls emit observations as `KEY=VALUE` for the agent to parse.

Captured values appear in terminal output. Capture observations only; leave sign-in and credential entry to the user through a `step`. Keep instructions about the script in adjacent Markdown.
