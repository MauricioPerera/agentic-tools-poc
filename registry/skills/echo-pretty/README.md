# echo-pretty

Pure text transform — uppercase/lowercase/prefix. Useful as a deterministic
sanity-check tool in agent pipelines and as a building block for piping with
real-world tools.

## Usage

```bash
echo-pretty --text "hello world" --upper
# → { "text": "HELLO WORLD", "length": 11 }

echo-pretty --text "Hi" --prefix ">> "
# → { "text": ">> Hi", "length": 5 }
```
