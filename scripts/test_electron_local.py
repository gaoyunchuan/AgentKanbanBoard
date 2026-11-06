"""验证安装门禁能拒绝缺失系统音频限制的主应用或 Helper。"""
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import electron_local


class AudioInputSignatureTests(unittest.TestCase):
    def verify(self, runtime=True, audio_input=False):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / '测试.app'
            helper = app / 'Contents/Frameworks/Helper.app'
            helper.mkdir(parents=True)

            def command(argv, **kwargs):
                if argv[1] == '-dv':
                    flags = '10002' if runtime or Path(argv[-1]) == app else '2'
                    return subprocess.CompletedProcess(argv, 0, b'', f'flags=0x{flags}'.encode())
                values = {'com.apple.security.device.audio-input': audio_input and Path(argv[-1]) == helper}
                return subprocess.CompletedProcess(argv, 0, plistlib.dumps(values), b'')

            with patch.object(electron_local, 'run'), patch.object(electron_local.subprocess, 'run', side_effect=command):
                electron_local.verify_app(app)

    def test_accepts_runtime_with_audio_input_disabled(self):
        self.verify()

    def test_rejects_helper_without_runtime(self):
        with self.assertRaises(RuntimeError):
            self.verify(runtime=False)

    def test_rejects_helper_with_audio_input(self):
        with self.assertRaises(RuntimeError):
            self.verify(audio_input=True)


if __name__ == '__main__':
    unittest.main()
