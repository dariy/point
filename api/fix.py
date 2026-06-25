import re

path = "internal/repository/queries_posts.go"
with open(path, "r") as f:
    content = f.read()

# Replace the specific lines safely using regex
fixed_block = """
	q := selectClause + "\\nWHERE " + strings.Join(where, "\\n    AND ")
	if orderByClause != "" {
		q += "\\n" + orderByClause
	}
	if limitOffsetClause != "" {
		q += "\\n" + limitOffsetClause
	}
"""

# Find where it says:
# q := selectClause + "
# WHERE " + strings.Join(where, "
#     AND ")
# ...
content = re.sub(r'q := selectClause \+ "\nWHERE " \+ strings.Join\(where, "\n    AND "\)\n\tif orderByClause != "" \{\n\t\tq \+= "\n" \+ orderByClause\n\t\}\n\tif limitOffsetClause != "" \{\n\t\tq \+= "\n" \+ limitOffsetClause\n\t\}', fixed_block.strip(), content)

with open(path, "w") as f:
    f.write(content)
