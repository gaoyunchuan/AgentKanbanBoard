"""Failure-path tests for the local macOS build/install boundary.

Native commands are simulated here. Actual codesign/hdiutil verification runs
on macOS during the development build; these tests do not assert OS trust.
"""

import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import macos_local as local


class FakeMacTools:
    def __init__(self, source, target):
        self.source = source
        self.target = target
        self.calls = []
        self.mount = None
        self.image_error = False
        self.attach_error = False
        self.detach_error = False
        self.mounted_signature_error = False
        self.installed_signature_error = False
        self.mounted_payload = None
        self.copied_payload = None
        self.signature = "adhoc"
        self.identifier = "local.test.kanban"

    def __call__(self, argv, **kwargs):
        argv = [str(arg) for arg in argv]
        self.calls.append((argv, kwargs))
        output = ""
        if argv[:2] == ["hdiutil", "verify"] and self.image_error:
            raise local.LocalBuildError("Image checksum failed")
        if argv[:2] == ["hdiutil", "attach"]:
            self.mount = Path(argv[argv.index("-mountpoint") + 1])
            shutil.copytree(self.source, self.mount / self.source.name)
            if self.mounted_payload:
                (self.mount / self.source.name / "payload").write_text(self.mounted_payload)
            if self.attach_error:
                raise local.LocalBuildError("Mount failed after attaching")
        if argv[:2] == ["hdiutil", "detach"]:
            if self.detach_error:
                raise local.LocalBuildError("Mount is busy")
            if self.mount is not None:
                shutil.rmtree(self.mount / self.source.name)
        if argv[0] == "ditto":
            shutil.copytree(Path(argv[1]), Path(argv[2]))
            if self.copied_payload:
                (Path(argv[2]) / "payload").write_text(self.copied_payload)
        if argv[:2] == ["codesign", "--verify"]:
            app = Path(argv[-1])
            if self.mounted_signature_error and self.mount is not None and app.parent == self.mount:
                raise local.LocalBuildError("Mounted app resource seal is invalid")
            if self.installed_signature_error and app == self.target:
                raise local.LocalBuildError("Installed resource seal is invalid")
        if argv[:2] == ["codesign", "-dv"]:
            app = Path(argv[-1])
            cdhash = hashlib.sha1((app / "payload").read_bytes()).hexdigest()
            output = f"Identifier={self.identifier}\nSignature={self.signature}\nCDHash={cdhash}\n"
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr=output)

    def called(self, *prefix):
        return any(argv[:len(prefix)] == list(prefix) for argv, _ in self.calls)


class MacosLocalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "src-tauri").mkdir()
        (self.root / "src-tauri/tauri.conf.json").write_text(json.dumps({
            "productName": "Local Test App", "identifier": "local.test.kanban", "version": "1.2.3"
        }))
        (self.root / "src-tauri/tauri.local.conf.json").write_text(json.dumps({
            "bundle": {"macOS": {"signingIdentity": "-"}}
        }))
        self.home = self.root / "home"
        self.home.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(local, "ROOT", self.root).start()
        patch.object(local.sys, "platform", "darwin").start()
        patch.object(local.Path, "home", return_value=self.home).start()
        self.native_temp = self.root / "native-temp"
        self.native_temp.mkdir()
        mkdtemp = tempfile.mkdtemp
        patch.object(local.tempfile, "mkdtemp", side_effect=lambda **kwargs: mkdtemp(
            **({"dir": self.native_temp} | kwargs)
        )).start()
        self.source = local.built_app()
        self.make_app(self.source, "new build")
        self.target = local.installed_app()
        self.native = FakeMacTools(self.source, self.target)
        self.run = patch.object(local, "run", side_effect=self.native).start()
        patch("sys.stdout", new_callable=io.StringIO).start()
        self.dmg = self.root / "test.dmg"
        self.dmg.write_bytes(b"development disk image")

    def make_app(self, path, payload):
        signature = path / "Contents/_CodeSignature"
        signature.mkdir(parents=True)
        (signature / "CodeResources").write_text("resource seal")
        (path / "payload").write_text(payload)

    def assert_no_reports(self):
        for sidecar in local.sidecars(self.dmg):
            self.assertFalse(sidecar.exists(), str(sidecar))

    def test_build_removes_apple_credentials_and_identity_without_mutating_environment(self):
        inherited = dict(local.os.environ)
        inherited.update({key: "private-value" for key in local.APPLE_SIGNING_ENV})
        expected = {key: value for key, value in inherited.items() if key not in local.APPLE_SIGNING_ENV}
        with patch.dict(local.os.environ, inherited, clear=True):
            local.build_app()
            self.assertTrue(dict(local.os.environ) == inherited, "Build mutated the inherited environment")
        command, options = self.native.calls[0]
        self.assertTrue(options["env"] == expected, "Only Apple signing variables should be removed")
        self.assertIn("--config", command)
        self.assertIn(str(self.root / "src-tauri/tauri.local.conf.json"), command)
        self.assertNotIn("--no-sign", command)

    def test_build_rejects_nonlocal_signing_configuration(self):
        (self.root / "src-tauri/tauri.local.conf.json").write_text(json.dumps({
            "bundle": {"macOS": {"signingIdentity": "Developer ID"}}
        }))
        with self.assertRaisesRegex(local.LocalBuildError, "signingIdentity"):
            local.build_app()
        self.run.assert_not_called()

    def test_bundle_requires_resource_manifest_and_expected_adhoc_identity(self):
        self.assertEqual(local.verify_app()["identifier"], "local.test.kanban")
        self.native.signature = "Developer ID"
        with self.assertRaisesRegex(local.LocalBuildError, "ad-hoc"):
            local.verify_app()
        self.native.signature = "adhoc"
        self.native.identifier = "wrong.app"
        with self.assertRaisesRegex(local.LocalBuildError, "identifier"):
            local.verify_app()
        (self.source / "Contents/_CodeSignature/CodeResources").unlink()
        with self.assertRaisesRegex(local.LocalBuildError, "resource manifest"):
            local.verify_app()

    def test_image_failure_invalidates_stale_reports_and_does_not_mount(self):
        for sidecar in local.sidecars(self.dmg):
            sidecar.write_text("old successful verification")
        self.native.image_error = True
        with self.assertRaisesRegex(local.LocalBuildError, "checksum"):
            local.verify_dmg(self.dmg)
        self.assert_no_reports()
        self.assertFalse(self.native.called("hdiutil", "attach"))

    def test_different_signed_app_in_image_is_rejected_and_detached(self):
        self.native.mounted_payload = "another validly signed app build"
        with self.assertRaisesRegex(local.LocalBuildError, "CDHash"):
            local.verify_dmg(self.dmg)
        self.assertTrue(self.native.called("hdiutil", "detach"))
        self.assertFalse(self.native.mount.exists())
        self.assert_no_reports()

    def test_broken_mounted_signature_is_detached_without_success_reports(self):
        self.native.mounted_signature_error = True
        with self.assertRaisesRegex(local.LocalBuildError, "resource seal"):
            local.verify_dmg(self.dmg)
        self.assertTrue(self.native.called("hdiutil", "detach"))
        self.assertFalse(self.native.mount.exists())
        self.assert_no_reports()

    def test_partial_mount_failure_still_attempts_detach(self):
        self.native.attach_error = True
        with self.assertRaisesRegex(local.LocalBuildError, "after attaching"):
            local.verify_dmg(self.dmg)
        self.assertTrue(self.native.called("hdiutil", "detach"))
        self.assertFalse(self.native.mount.exists())
        self.assert_no_reports()

    def test_detach_failure_preserves_mount_and_does_not_publish_success(self):
        self.native.detach_error = True
        with self.assertRaisesRegex(local.LocalBuildError, "preserved for cleanup"):
            local.verify_dmg(self.dmg)
        self.assertTrue((self.native.mount / self.source.name / "payload").exists())
        self.assert_no_reports()

    def test_success_reports_integrity_without_claiming_os_trust(self):
        report = local.verify_dmg(self.dmg)
        checksum, saved_report = local.sidecars(self.dmg)
        expected_hash = hashlib.sha256(self.dmg.read_bytes()).hexdigest()
        self.assertEqual(checksum.read_text(), f"{expected_hash}  test.dmg\n")
        self.assertEqual(json.loads(saved_report.read_text()), report)
        self.assertEqual(report["distribution"], "local-development")
        self.assertIs(report["notarized"], False)
        self.assertEqual(report["gatekeeper"], "not-assessed")
        self.assertEqual(report["managed_device_policy"], "not-assessed")
        self.assertFalse(self.native.called("spctl"))
        self.assertFalse(self.native.mount.exists())
        attach = next(argv for argv, _ in self.native.calls if argv[:2] == ["hdiutil", "attach"])
        self.assertIn("-readonly", attach)
        self.assertIn("-nobrowse", attach)

    def test_report_write_failure_removes_partial_success_evidence(self):
        _, report_path = local.sidecars(self.dmg)
        original_write = Path.write_text

        def fail_report(path, text, *args, **kwargs):
            result = original_write(path, text, *args, **kwargs)
            if path == report_path:
                raise OSError("report disk write failed")
            return result

        with patch.object(local.Path, "write_text", fail_report):
            with self.assertRaisesRegex(OSError, "disk write"):
                local.verify_dmg(self.dmg)
        self.assert_no_reports()

    def test_staging_validation_failure_keeps_old_install_and_task_data(self):
        self.make_app(self.target, "previous installation")
        database = self.home / ".codex-kanban/app.db"
        database.parent.mkdir()
        database.write_bytes(b"existing tasks")
        self.native.copied_payload = "copy differs from original"
        with self.assertRaisesRegex(local.LocalBuildError, "CDHash"):
            local.install_app()
        self.assertEqual((self.target / "payload").read_text(), "previous installation")
        self.assertEqual(database.read_bytes(), b"existing tasks")
        self.assertEqual(list(self.target.parent.glob("*.backup-*.app")), [])
        self.assertEqual(list(self.target.parent.glob(".agentkanban-install-*")), [])

    def test_failed_replacement_rename_rolls_back_previous_install(self):
        self.make_app(self.target, "previous installation")
        original_rename = Path.rename

        def fail_replacement(path, destination):
            if path.parent.name.startswith(".agentkanban-install-") and Path(destination) == self.target:
                raise OSError("simulated replacement failure")
            return original_rename(path, destination)

        with patch.object(local.Path, "rename", fail_replacement):
            with self.assertRaisesRegex(OSError, "replacement failure"):
                local.install_app()
        self.assertEqual((self.target / "payload").read_text(), "previous installation")
        self.assertEqual(list(self.target.parent.glob("*.backup-*.app")), [])

    def test_post_install_validation_failure_restores_previous_install(self):
        self.make_app(self.target, "previous installation")
        self.native.installed_signature_error = True
        with self.assertRaisesRegex(local.LocalBuildError, "resource seal"):
            local.install_app()
        self.assertEqual((self.target / "payload").read_text(), "previous installation")
        self.assertEqual(list(self.target.parent.glob("*.backup-*.app")), [])

    def test_successful_install_retains_previous_app_as_unique_backup(self):
        self.make_app(self.target, "previous installation")
        earlier_backup = self.target.with_name("Local Test App.backup-earlier.app")
        self.make_app(earlier_backup, "older installation")
        local.install_app()
        self.assertEqual((self.target / "payload").read_text(), "new build")
        backups = list(self.target.parent.glob("*.backup-*.app"))
        self.assertEqual(len(backups), 2)
        self.assertEqual({(path / "payload").read_text() for path in backups}, {
            "older installation", "previous installation"
        })

    def test_open_uses_normal_system_launch_without_bypass_flags(self):
        self.make_app(self.target, "installed app")
        local.open_app()
        self.assertEqual(self.native.calls[-1][0], ["open", str(self.target)])

    def test_nonmacos_rejected_before_native_commands_or_report_changes(self):
        checksum, _ = local.sidecars(self.dmg)
        checksum.write_text("existing report")
        with patch.object(local.sys, "platform", "linux"):
            for operation in (local.build_app, local.verify_app, lambda: local.verify_dmg(self.dmg),
                              local.install_app, local.open_app):
                with self.assertRaisesRegex(local.LocalBuildError, "requires macOS"):
                    operation()
        self.assertEqual(checksum.read_text(), "existing report")
        self.run.assert_not_called()


class NativeCommandTests(unittest.TestCase):
    def test_native_failure_includes_limited_diagnostic_without_echoing_argv(self):
        result = subprocess.CompletedProcess(["codesign"], 1, "", "x" * 2500 + "invalid seal")
        with patch.object(local.subprocess, "run", return_value=result):
            with self.assertRaises(local.LocalBuildError) as failure:
                local.run(["codesign", "private-argument"], label="Signature check")
        self.assertIn("invalid seal", str(failure.exception))
        self.assertNotIn("private-argument", str(failure.exception))
        self.assertLess(len(str(failure.exception)), 2100)

    def test_failure_does_not_print_command_arguments_or_subprocess_output(self):
        result = subprocess.CompletedProcess(["tool", "private-argument"], 1, "private-output", "private-error")
        with patch.object(local.subprocess, "run", return_value=result) as process:
            with self.assertRaises(local.LocalBuildError) as failure:
                local.run(["tool", "private-argument"], label="Safe operation label")
        self.assertEqual(str(failure.exception), "Safe operation label failed (exit 1).")
        self.assertEqual(process.call_args.kwargs["cwd"], local.ROOT)
        self.assertNotIn("shell", process.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
