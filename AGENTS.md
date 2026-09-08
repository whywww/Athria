# Repository workflow

- After modifying application code, always run `bun run build:app` before handing the work back to the user.
- Treat the runnable desktop application build as part of completion, in addition to relevant type checks and tests.
- Report whether the App build succeeded and include the generated application path in the final response.
