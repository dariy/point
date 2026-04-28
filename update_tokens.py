import os
import re

css_dir = 'frontend/css'

def process_file(filepath):
    # Only process tokens.css files
    if 'tokens.css' not in filepath:
        return
        
    with open(filepath, 'r') as f:
        lines = f.readlines()

    original_lines = list(lines)

    # Pattern to match positive rem values
    pattern = re.compile(r'(?<![a-zA-Z0-9_])([0-9]*\.?[0-9]+)rem')
    
    def replacer(match):
        val = match.group(1)
        if val.startswith('.'):
            val = '0' + val
        if '.' in val:
            val = val.rstrip('0')
            if val.endswith('.'):
                val = val[:-1]
        if val == '' or val == '0':
            return '0'
        token_name = f"--size-{val.replace('.', '-')}"
        return f"var({token_name})"

    for i, line in enumerate(lines):
        # Skip the lines where we define --size-*
        if line.strip().startswith('--size-'):
            continue
            
        # Also skip calc() if it's already using var(--size-*)
        # We just apply the replacer to the line
        new_line = pattern.sub(replacer, line)
        lines[i] = new_line

    if lines != original_lines:
        with open(filepath, 'w') as f:
            f.writelines(lines)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk(css_dir):
    for file in files:
        if file.endswith('.css'):
            process_file(os.path.join(root, file))
