import os
import re

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Regex to match var(--name, hardcoded_value) and replace with var(--name)
    # This covers hex colors, rgb/rgba, and relative/absolute units (rem, px, em, %, etc)
    pattern = r'var\((--[a-zA-Z0-9_-]+)\s*,\s*(#[a-fA-F0-9]+|rgba?\([^)]+\)|[0-9.]+(?:rem|px|em|vh|vw|%))\)'
    
    new_content = re.sub(pattern, r'var(\1)', content)
    
    # Sometimes there are nested or multiple fallbacks. Let's run it a few times to be safe.
    for _ in range(3):
        new_content = re.sub(pattern, r'var(\1)', new_content)
        
    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Updated fallbacks in {filepath}")

for root, dirs, files in os.walk('frontend/css'):
    for file in files:
        if file.endswith('.css'):
            process_file(os.path.join(root, file))
