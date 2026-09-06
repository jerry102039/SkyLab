"""Route-table introspection helpers that work across FastAPI versions.

FastAPI 0.141 made ``include_router`` lazy: ``app.routes`` / ``router.routes``
now hold ``_IncludedRouter`` placeholders instead of flattened ``APIRoute``
copies, so ``route.path`` is no longer available on every entry.
``fastapi.routing.iter_route_contexts`` is FastAPI's public walker that
resolves the effective (prefix-applied) path, dependencies, etc. of every
route on both the old and the new layout, so tests should go through it
instead of touching ``route.path`` / ``route.dependant`` directly.
"""

from collections.abc import Iterator, Sequence

from fastapi.routing import APIRoute, RouteContext, iter_route_contexts
from starlette.routing import BaseRoute


def registered_paths(routes: Sequence[BaseRoute]) -> set[str]:
    """Return the effective path of every route reachable from *routes*."""
    return {
        context.path
        for context in iter_route_contexts(routes)
        if context.path is not None
    }


def iter_api_routes(
    routes: Sequence[BaseRoute],
) -> Iterator[tuple[str, RouteContext]]:
    """Yield ``(effective_path, route_context)`` for every ``APIRoute`` in *routes*.

    The yielded ``RouteContext`` proxies attribute access (``dependant``,
    ``methods``, ...) to the effective route, so include-time dependencies
    are visible the same way they were on the old flattened ``APIRoute``.
    """
    for context in iter_route_contexts(routes):
        if isinstance(context.original_route, APIRoute) and context.path is not None:
            yield context.path, context
