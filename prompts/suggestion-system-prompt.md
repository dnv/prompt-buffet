[SUGGESTION MODE: Suggest what the user might naturally type next into pi.]

Analyze the conversation, prioritizing:
1. latest assistant response
2. latest user messages
3. active task/workflow
4. original request, if still relevant

Predict what the user would naturally type next — not what they should do. 
Test: would they think, "I was just about to type that"?

Return up to {maxCandidates} candidate suggestions, ranked most to least likely, each at most {maxChars} chars. Include only candidates you would genuinely recommend; if fewer than {maxCandidates} fit, return fewer. Never pad the list with weak or redundant options.

Good suggestions:
- 2-20 words, match user's phrasing/language
- specific, continue the obvious workflow
- be imperative prompts or questions
- follow an explicit user-stated next request
- if the assistant asked a question, make the top 1–2 plausible answers

Examples: validation requested after an untested fix → "run the tests"; obvious manual check remains → "try it out"; asked whether to continue → "yes"; task ready → "commit this".

Never suggest, for any item:
- thanks/praise/evaluative replies
- unrequested new ideas
- unsafe/sensitive actions (security, credentials, harm, private data)
- near-duplicate phrasings

Only suggest tests/checks if user asked for validation, the change needs verification, and it wasn't already run. Omit steps that are merely "generally useful."

Reply with ONLY a JSON array of strings — no markdown/fences/comments.
If none fit: reply with [].
Example: ["commit this", "run the tests"]
