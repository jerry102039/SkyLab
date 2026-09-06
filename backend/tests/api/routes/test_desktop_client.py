from pathlib import Path

from app.api.routes import desktop_client
from app.core.config import settings


def _write(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"test")
    return path


def test_find_local_download_asset_prefers_static_download(tmp_path, monkeypatch) -> None:
    static_dir = tmp_path / "static" / "downloads"
    release_dir = tmp_path / "desktop-client" / "release"
    static_zip = _write(static_dir / "campus-cloud-connect.zip")
    _write(release_dir / "0.1.0" / "Campus Cloud Connect Setup 0.1.0.exe")

    monkeypatch.setattr(desktop_client, "_STATIC_DIR", static_dir)
    monkeypatch.setattr(desktop_client, "_DESKTOP_RELEASE_DIR", release_dir)

    assert desktop_client._find_local_download_asset() == static_zip


def test_find_local_download_asset_falls_back_to_latest_release_installer(
    tmp_path,
    monkeypatch,
) -> None:
    static_dir = tmp_path / "static" / "downloads"
    release_dir = tmp_path / "desktop-client" / "release"
    portable = _write(release_dir / "0.1.0" / "Campus Cloud Connect 0.1.0.exe")
    installer = _write(
        release_dir / "0.1.0" / "Campus Cloud Connect Setup 0.1.0.exe"
    )
    assert portable.exists()

    monkeypatch.setattr(desktop_client, "_STATIC_DIR", static_dir)
    monkeypatch.setattr(desktop_client, "_DESKTOP_RELEASE_DIR", release_dir)

    assert desktop_client._find_local_download_asset() == installer


def test_find_local_download_asset_ignores_blockmap_files(tmp_path, monkeypatch) -> None:
    static_dir = tmp_path / "static" / "downloads"
    release_dir = tmp_path / "desktop-client" / "release"
    _write(release_dir / "0.1.0" / "Campus Cloud Connect Setup 0.1.0.exe.blockmap")

    monkeypatch.setattr(desktop_client, "_STATIC_DIR", static_dir)
    monkeypatch.setattr(desktop_client, "_DESKTOP_RELEASE_DIR", release_dir)

    assert desktop_client._find_local_download_asset() is None


def test_download_redirects_to_configured_public_release(monkeypatch) -> None:
    release_url = (
        "https://github.com/1Ray0/SkyLab-Connect-Releases/"
        "releases/latest/download/SkyLab-Connect-Setup.exe"
    )
    monkeypatch.setattr(settings, "DESKTOP_CLIENT_DOWNLOAD_URL", release_url)

    response = desktop_client.download_desktop_client()

    assert response.status_code == 302
    assert response.headers["location"] == release_url
