# Critique lens: api-backend
<!-- critique-categories: consumers trust input authorization errors repeated-calls exemplars -->

Use with the shared critique prompt. You receive the full diff, the approved contract if there is one, the recorded requests to the local service, and the results of route-hygiene, cross-account, repeat-abuse, request-evidence and contract-diff with their exit codes. If contract-diff came back BLOCKED because the repo has no machine-readable surface, question 1 is yours to answer by reading the routes in the diff.

Answer each question. Every issue names the file:line or the operation (`METHOD /path`) and gives a concrete fix.

1. **Consumers.** List every operation whose request or response changed. For each, say whether an existing client keeps working without a change. A removed field, a parameter that became required, a renamed path or a status code that moved from success to error breaks clients, even if the contract check missed it.
2. **The server decides what grants trust.** Balances, prices, roles, quotas, discounts, ownership and feature access are read or computed on the server. If the handler takes any of them from the request body, a header the client sets, or a value the client computed, that is an issue whatever the tests say.
3. **Input at the boundary.** Every field the handler reads from the body, query or path is parsed into a known shape before use. Look for fields that are read after validation but were never in the schema, and for numbers and dates used without range checks.
4. **Who may call this.** Each route has a guard or a written public decision. For routes that take an id, the lookup is scoped to the caller. An admin route that only checks "signed in" is an issue.
5. **Error semantics.** Wrong input is 4xx with a message the client can act on; a server fault is 5xx and does not leak stack traces, queries or secrets. Not found and not allowed are distinguished only where revealing existence is safe.
6. **Repeated calls.** Calling the route twice with the same input, or many times quickly, does not credit, send or charge twice, unless the card says why that is acceptable.
7. **Consistency with the exemplars.** Naming, error body shape, pagination style and status codes match the routes the owner cited. A second style for the same thing is an issue.
8. **Checks gamed.** Markers added only to satisfy a check (an unused validator import, a guard that always passes, a comment saying "auth: public" on a route that serves private data), requests recorded against something other than the local service, or a contract file edited to match the result after approval.
