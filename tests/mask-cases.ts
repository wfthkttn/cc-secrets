// After `export default` this file is plain JSON: tests/mask_run_test.py runs the same cases against mask-run.
export default [
  { "values": ["hunter22"], "min": 6, "input": "pass=hunter22 ok", "output": "[secret] ok" },
  { "values": ["hunter22"], "min": 6, "input": "xhunter22y z", "output": "[secret] z" },
  { "values": ["abcdefgh", "efghijkl"], "min": 6, "input": "start abcdefghijkl end", "output": "start [secret] end" },
  { "values": ["secret-token-1", "token-1"], "min": 7, "input": "secret-token-1 and token-1", "output": "[secret] and [secret]" },
  { "values": ["s3cr3tpass"], "min": 6, "input": "Authorization: Basic YWxleDpzM2NyM3RwYXNz", "output": "Authorization: Basic [secret]" },
  { "values": ["s3cr3tpass"], "min": 6, "input": "czNjcjN0cGFzcwo=\nnext", "output": "[secret]\nnext" },
  { "values": ["s3cr3tpass"], "min": 6, "input": "u=eHk6czNjcjN0cGFzc0Bob3N0", "output": "[secret]" },
  { "values": ["p@ss w0rd!"], "min": 6, "input": "https://u:p%40ss%20w0rd%21@host/x done", "output": "[secret] done" },
  { "values": ["p@ss w0rd!"], "min": 6, "input": "q=p%40ss%20w0rd%21 done", "output": "[secret] done" },
  { "values": ["a\"b\\c-123"], "min": 6, "input": "{\"k\":\"a\\\"b\\\\c-123\"}", "output": "[secret]" },
  { "values": ["it's-secret"], "min": 6, "input": "echo 'it'\\''s-secret'", "output": "echo [secret]" },
  { "values": ["hunter22"], "min": 6, "input": "x 68756e7465723232 68756E7465723232", "output": "x [secret] [secret]" },
  { "values": ["abc"], "min": 6, "input": "abc stays", "output": "abc stays" },
  { "values": ["hunter22"], "min": 6, "input": "line1\nhunter22\nline3", "output": "line1\n[secret]\nline3" },
  { "values": ["ключик-42"], "min": 6, "input": "{\"k\": \"\\u043a\\u043b\\u044e\\u0447\\u0438\\u043a-42\"}", "output": "{\"k\": [secret]" },
  { "values": ["ключик-42"], "min": 6, "input": "{\"k\": \"ключик-42\"} ok", "output": "{\"k\": [secret] ok" },
  { "values": ["pass word 1"], "min": 6, "input": "say pass word 1 now", "output": "say [secret] now" }
]
