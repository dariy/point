import asyncio
import sys

import httpx


async def post(url: str):
    payload = {}
    async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload)
            print(response.status_code)
            print(response.json())

if len(sys.argv) > 1:
    asyncio.run(post(sys.argv[1]))
else:
    asyncio.run(post("http://point-ai:8082"))
