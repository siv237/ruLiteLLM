import asyncio
from typing import Final

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_LLM_STREAM_PATHS: Final[frozenset[str]] = frozenset(
    {
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/messages",
        "/v1/responses",
        "/chat/completions",
        "/completions",
        "/messages",
        "/responses",
    }
)


class ClientDisconnectAbortMiddleware:
    """Cancel the request task when the client disconnects mid-generation.

    Without it a streaming response keeps pulling from the upstream backend
    after the caller is gone, and the backend keeps generating for a client
    that no longer exists.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] not in _LLM_STREAM_PATHS:
            await self.app(scope, receive, send)
            return

        queue: Final[asyncio.Queue[Message]] = asyncio.Queue()
        finished: Final = asyncio.Event()
        task: Final = asyncio.current_task()

        async def pump() -> None:
            while True:
                message: Final = await receive()
                await queue.put(message)
                if message["type"] == "http.disconnect":
                    if not finished.is_set() and task is not None:
                        task.cancel()
                    return

        async def queued_receive() -> Message:
            return await queue.get()

        watcher: Final = asyncio.create_task(pump())
        try:
            await self.app(scope, queued_receive, send)
        finally:
            finished.set()
            watcher.cancel()
