import os
import re

css_dir = 'frontend/css'
tokens_file = 'frontend/css/common/tokens.css'

new_tokens = {}

def process_file(filepath):
    if 'tokens.css' in filepath:
        return
    with open(filepath, 'r') as f:
        content = f.read()

    original_content = content

    # Find all rem values, including negative ones
    # Match optional minus, then numbers and optional decimal, then rem
    # We must not match inside var(...) if it already exists, though our regex might be simple enough
    # Use a replacer function
    pattern = re.compile(r'(?<![a-zA-Z0-9_])(-?)([0-9]*\.?[0-9]+)rem')
    
    def replacer(match):
        sign = match.group(1)
        val = match.group(2)
        
        # Normalize value string (e.g. .5 -> 0.5)
        if val.startswith('.'):
            val = '0' + val
            
        # Clean trailing zeros if there's a decimal
        if '.' in val:
            val = val.rstrip('0')
            if val.endswith('.'):
                val = val[:-1]
                
        if val == '' or val == '0':
            return '0' # 0rem is just 0
            
        token_name = f"--size-{val.replace('.', '-')}"
        
        if token_name not in new_tokens:
            new_tokens[token_name] = f"{val}rem"
            
        if sign == '-':
            return f"calc(var({token_name}) * -1)"
        else:
            return f"var({token_name})"

    # We need to only replace outside of existing var() if there are any.
    # A simple approach is to split by var() and only replace outside.
    parts = re.split(r'(var\([^)]+\))', content)
    for i in range(0, len(parts), 2): # Even indices are outside var()
        parts[i] = pattern.sub(replacer, parts[i])
        
    content = ''.join(parts)

    if content != original_content:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk(css_dir):
    for file in files:
        if file.endswith('.css'):
            process_file(os.path.join(root, file))

if new_tokens:
    print(f"New tokens to add: {len(new_tokens)}")
    with open(tokens_file, 'r') as f:
        tokens_content = f.read()
    
    tokens_str = "\n    /* Sizes & Measures */\n"
    
    # Sort numerically
    def sort_key(item):
        return float(item[1].replace('rem', ''))
        
    for name, val in sorted(new_tokens.items(), key=sort_key):
        tokens_str += f"    {name}: {val};\n"
        
    # Append before the closing root brace
    tokens_content = tokens_content.replace('    /* Spacing */', tokens_str + '\n    /* Spacing */')
    
    with open(tokens_file, 'w') as f:
        f.write(tokens_content)
    print(f"Added {len(new_tokens)} new tokens to {tokens_file}")
