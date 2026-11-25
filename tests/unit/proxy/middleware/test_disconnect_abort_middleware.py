import asyncio

import pytest

from litellm.proxy.middleware.disconnect_abort_middleware import ClientDisconnectAbortMiddleware


async def _forever_app(scope, receive, send):
    started.set()
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError:
        cancelled.set()
        raise


started = asyncio.Event()
cancelled = asyncio.Event()


async def _run_middleware(path, receive):
    async def send(message):
        return None

    middleware = ClientDisconnectAbortMiddleware(_forever_app)
    return asyncio.create_task(middleware({"type": "http", "path": path}, receive, send))


async def test_client_disconnect_cancels_in_flight_generation():
    started.clear()
    cancelled.clear()

    async def receive():
        await started.wait()
        return {"type": "http.disconnect"}

    task = await _run_middleware("/v1/chat/completions", receive)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()


async def test_disconnect_after_completion_does_not_cancel():
    started.clear()
    cancelled.clear()

    async def app(scope, receive, send):
        return None

    async def receive():
        return {"type": "http.disconnect"}

    middleware = ClientDisconnectAbortMiddleware(app)
    await asyncio.wait_for(
        middleware({"type": "http", "path": "/v1/chat/completions"}, receive, _noop_send),
        timeout=2,
    )
    assert not cancelled.is_set()


async def _noop_send(message):
    return None


async def test_non_llm_path_is_passed_through():
    started.clear()
    cancelled.clear()

    async def receive():
        await started.wait()
        return {"type": "http.disconnect"}

    middleware = ClientDisconnectAbortMiddleware(_forever_app)

    async def send(message):
        return None

    task = asyncio.create_task(middleware({"type": "http", "path": "/health/liveliness"}, receive, send))
    await asyncio.wait_for(started.wait(), timeout=2)
    assert not cancelled.is_set()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
