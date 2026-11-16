"""DeepFilterNet 3 speech enhancement - executed by the DeepFilterNet venv's python, NOT the engine env.

    <dfnet python> dfn_runner.py <in.wav> <out.wav> [<in2.wav> <out2.wav> ...]

Input: any wav (resampled to the model rate, 48 kHz). Output: 48 kHz mono enhanced wav.
"""
import sys
import warnings

warnings.filterwarnings("ignore")

from df.enhance import enhance, init_df, load_audio, save_audio  # noqa: E402


def main():
    args = sys.argv[1:]
    assert args and len(args) % 2 == 0, "pairs of <in> <out>"
    model, df_state, _ = init_df(log_level="ERROR")
    sr = df_state.sr()
    for src, dst in zip(args[::2], args[1::2]):
        audio, _ = load_audio(src, sr=sr)
        save_audio(dst, enhance(model, df_state, audio), sr)
        print("OK", dst, flush=True)


if __name__ == "__main__":
    main()
