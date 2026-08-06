"""Behavioral tests for the Cloudflare exec()-env-gated image-build entrypoint."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.entrypoint import CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT
from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
)


def _set_cloudflare_build_context(monkeypatch):
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    monkeypatch.setenv("SANDBOX_ID", "build-imgb-acme-repo-123-abc")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "repo")
    monkeypatch.setenv("SESSION_CONFIG", "{}")
    monkeypatch.setenv(BUILD_ID_ENV, "imgb-acme-repo-123-abc")
    monkeypatch.setenv(
        CALLBACK_URL_ENV,
        "https://control-plane.test/image-builds/build-complete",
    )
    monkeypatch.setenv(
        FAILURE_CALLBACK_URL_ENV,
        "https://control-plane.test/image-builds/build-failed",
    )
    monkeypatch.setenv(CALLBACK_TOKEN_ENV, "a" * 64)
    monkeypatch.setenv(PROVIDER_SESSION_ID_ENV, "sb-provider-123")


@pytest.mark.asyncio
async def test_unflagged_entrypoint_keeps_normal_supervisor_path(monkeypatch):
    from sandbox_runtime import entrypoint

    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([])

    assert exit_code == 0
    run.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_cloudflare_entrypoint_fails_closed_outside_image_build_mode(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_cloudflare_build_context(monkeypatch)
    monkeypatch.delenv("IMAGE_BUILD_MODE")
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    run.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed", reason="invalid_build_mode"
    )


@pytest.mark.asyncio
async def test_cloudflare_entrypoint_requires_build_identity(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_cloudflare_build_context(monkeypatch)
    monkeypatch.delenv(BUILD_ID_ENV)
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    run.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed", reason="missing_build_identity"
    )


@pytest.mark.asyncio
async def test_cloudflare_entrypoint_aborts_on_partial_callback_configuration(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_cloudflare_build_context(monkeypatch)
    monkeypatch.delenv(CALLBACK_TOKEN_ENV)
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    run.assert_not_awaited()
    error_call = supervisor.log.error.call_args
    assert error_call.args == ("image_build.launch_failed",)
    assert error_call.kwargs["build_id"] == "imgb-acme-repo-123-abc"
    assert "partial build-callback configuration" in error_call.kwargs["reason"]


@pytest.mark.asyncio
async def test_cloudflare_entrypoint_runs_supervisor_and_scrubs_callback_env(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_cloudflare_build_context(monkeypatch)
    observed_hook_env = {}
    observed_callback = {}

    async def fake_run(callback=None):
        observed_callback["value"] = callback
        # _hook_env() is what repo setup.sh/start.sh scripts inherit from —
        # confirm the callback env vars are gone from os.environ by the time
        # the supervisor (and therefore any hook it runs) is invoked.
        observed_hook_env.update(entrypoint.SandboxSupervisor._hook_env(supervisor))
        return True

    run = AsyncMock(side_effect=fake_run)
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 0
    run.assert_awaited_once()
    callback = observed_callback["value"]
    assert callback.build_id == "imgb-acme-repo-123-abc"
    assert callback.provider_session_id == "sb-provider-123"
    assert callback.token == "a" * 64
    for env_var in (
        BUILD_ID_ENV,
        CALLBACK_URL_ENV,
        FAILURE_CALLBACK_URL_ENV,
        CALLBACK_TOKEN_ENV,
        PROVIDER_SESSION_ID_ENV,
    ):
        assert env_var not in entrypoint.os.environ
        assert env_var not in observed_hook_env


@pytest.mark.asyncio
async def test_cloudflare_entrypoint_returns_failure_when_supervisor_reports_failed_build(
    monkeypatch,
):
    from sandbox_runtime import entrypoint

    _set_cloudflare_build_context(monkeypatch)
    supervisor = MagicMock(run=AsyncMock(return_value=False), shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    supervisor.run.assert_awaited_once()


@pytest.mark.asyncio
async def test_cloudflare_entrypoint_does_not_relabel_supervisor_errors_as_launch_failures(
    monkeypatch,
):
    from sandbox_runtime import entrypoint

    _set_cloudflare_build_context(monkeypatch)
    supervisor = MagicMock(
        run=AsyncMock(side_effect=ValueError("unexpected build error")),
        shutdown_event=asyncio.Event(),
    )
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    with pytest.raises(ValueError, match="unexpected build error"):
        await entrypoint.main([CLOUDFLARE_IMAGE_BUILD_START_ARGUMENT])

    supervisor.run.assert_awaited_once()
    assert all(
        call.args != ("image_build.launch_failed",) for call in supervisor.log.error.call_args_list
    )
