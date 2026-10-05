# Wizard template

Copy `template.sh` and author only `run_stages`. The helpers before it form the shared library. Set `TOTAL_STAGES` inside the function, open with `banner`, and end with `finish`. Replace the Stripe example with the actual procedure.

## Display and navigation

- `banner "Title"` clears the terminal and waits for confirmation.
- `stage "Name"` clears the terminal and advances the progress counter. Redirected output is not cleared.
- `say`, `step`, `note`, and `warn` display instructions, actions, secondary information, and warnings.
- `open_url URL` opens the browser using an available WSL, Windows, Linux, or macOS launcher. If none succeeds, it asks the user to open the URL manually.
- `pause "Message"` waits for Enter.
- `confirm "Question"` succeeds only for a reply beginning with y or Y.

## Input and persistence

`ask KEY "Prompt"` reads visible input into the named variable. `ask_secret` uses hidden input and adds a newline afterward. Both offer the last matching value from `ENV_FILE` as a default; Enter keeps it. Input alone does not persist anything.

`ENV_FILE` defaults to `.env`. `write_env KEY VALUE` creates the file if necessary and replaces existing assignments for that key. `WRITTEN_ENV` records the keys written during this run.

`set_secret NAME VALUE` sets a GitHub Actions repository secret only when `gh` is available and authenticated. It records successful names in `WRITTEN_SECRET`; failures are reported and added to `SKIPPED`. `set_var` similarly sets a non-secret repository variable.

`finish` displays a summary of persisted values, GitHub secrets, and skipped manual work. The example writes both Stripe keys locally but sends only the secret key to CI.

Keep procedure explanations in adjacent Markdown rather than code comments.
