# Critique lens: docs
<!-- critique-categories: commands reader-task filler claims examples -->

Use with the shared critique prompt. You receive the approved outline, the full diff of the pages, the doc-check result with its exit code, the recorded runs of runnable blocks and the help text recorded for the repo's tools. doc-check confirms that names exist; your job is whether a reader can finish the task.

Answer each question. Every issue names the file:line and gives a concrete fix.

1. **Commands and flags that only look right.** doc-check skips tools without recorded help and blocks not marked runnable. For each command in the new text, say where in the repo it is defined, and whether its arguments, defaults, output and exit behaviour match the code at head. A command copied from another project, an old version or a guess is an issue.
2. **Reader task.** Take the reader and task from the outline and walk the page as that reader, starting from a clean checkout. Name the first step that is missing, out of order or assumes knowledge the page does not give: a setting, an account, an environment variable, a prerequisite page.
3. **Filler.** Name every sentence that could be removed without the reader losing a step, a fact or a warning: restated headings, generic praise, sign-offs, paragraphs that repeat a code block in words. Give the shorter version.
4. **Claims about behaviour.** Every sentence that says what the software does (limits, defaults, errors, performance, compatibility) points at code, a test or a recorded run. An unsupported claim is an issue, even when it is probably true.
5. **Examples.** Example input and output are consistent with each other and with the current code; names, values and paths are synthetic or come from the repo, never from private data. An example that cannot work as written is an issue.
6. **Checks gamed.** A command moved into a block with an unknown language so it is not read, a runnable marker dropped to avoid recording a run, a link turned into plain text, or the outline edited after approval to match the page.
