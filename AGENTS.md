# PiQ Harness

Keep the channel small: persist messages, aggregate a signal, and expose explicit sending.
Let Pi decide whether to read, reply, remember, or save assets. Do not forward normal assistant output.
Each conversation group owns one directory and one Pi Agent Session. Keep each member conversation's logs separate and use an explicit reply target. Read configuration from the current Pi context's cwd.
Human instructions belong in Markdown; conversation records belong in JSONL; credentials belong in environment variables.
Never add SnowLuma SDK or copy its implementation. Implement protocol access independently from public OneBot and backend API documentation.
Use `npm run verify` before delivery. Tests must use temporary directories and simulated QQ endpoints.
Never send a real QQ message as a test.
