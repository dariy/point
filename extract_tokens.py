import os
import re

css_dir = 'frontend/css'
tokens_file = 'frontend/css/common/tokens.css'

# Predefined hex maps to existing tokens
hex_map = {
    '#fff': 'var(--color-white)',
    '#ffffff': 'var(--color-white)',
    '#000': 'var(--color-black)',
    '#000000': 'var(--color-black)',
    '#059669': 'var(--color-emerald-600)',
    '#dc2626': 'var(--color-rose-600)',
    '#f59e0b': 'var(--color-amber-500)',
    '#fffbeb': 'var(--color-amber-50)',
    '#92400e': 'var(--color-amber-800)',
    '#1d4ed8': 'var(--color-primary-hover)',
    '#ef4444': 'var(--color-danger)',
    '#10b981': 'var(--color-emerald-500)',
}

rgba_bases = {
    '255, 255, 255': 'white',
    '0, 0, 0': 'black',
    '37, 99, 235': 'primary',
    '59, 130, 246': 'primary-light',
    '16, 185, 129': 'success',
    '239, 68, 68': 'danger',
    '245, 158, 11': 'warning',
    '180, 120, 0': 'warning-dark'
}

new_tokens = {}

def process_file(filepath):
    if 'tokens.css' in filepath:
        return
    with open(filepath, 'r') as f:
        content = f.read()

    original_content = content

    # Replace hex
    for hex_val, var_name in hex_map.items():
        pattern = re.compile(hex_val + r'(?![a-zA-Z0-9])', re.IGNORECASE)
        content = pattern.sub(var_name, content)
        
    # Replace rgba
    rgba_pattern = re.compile(r'rgba?\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9.]+)\s*\)')
    def rgba_replacer(match):
        r, g, b, a = match.groups()
        rgb_str = f"{r}, {g}, {b}"
        base_name = rgba_bases.get(rgb_str, f"rgb-{r}-{g}-{b}")
        
        # Format alpha properly (e.g. 0.5 -> 50, 0.08 -> 08)
        a_float = float(a)
        if a_float == 0 or a_float == 1:
            a_name = str(int(a_float * 100))
        else:
            a_str = f"{a_float:.2f}"
            a_name = a_str.split('.')[1].rstrip('0')
            if len(a_name) == 1: a_name += '0'
            if a_name == '': a_name = '00'
            
        # Hardcode some overrides for neatness
        if a == '0.1875': a_name = '18'
        if a == '0.0625': a_name = '06'
        
        var_name = f"--color-{base_name}-alpha-{a_name}"
        if var_name not in new_tokens:
            # Reconstruct neat rgba
            new_tokens[var_name] = f"rgba({r}, {g}, {b}, {a})"
            
        return f"var({var_name})"

    content = rgba_pattern.sub(rgba_replacer, content)

    if content != original_content:
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"Updated {filepath}")

for root, dirs, files in os.walk(css_dir):
    for file in files:
        if file.endswith('.css'):
            process_file(os.path.join(root, file))

if new_tokens:
    print("New tokens to add:")
    with open(tokens_file, 'r') as f:
        tokens_content = f.read()
    
    tokens_str = "\n    /* Extracted Alpha Colors */\n"
    for name, val in sorted(new_tokens.items()):
        tokens_str += f"    {name}: {val};\n"
        
    tokens_content = tokens_content.replace('    /* Transitions */', tokens_str + '\n    /* Transitions */')
    
    with open(tokens_file, 'w') as f:
        f.write(tokens_content)
    print(f"Added {len(new_tokens)} new tokens to {tokens_file}")
