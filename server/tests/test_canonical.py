"""Canonical-hash parity tests.

These mirror the table in ``layout-core/src/__tests__/canonical.test.ts``. If a
value here stops matching that table, the two runtimes have diverged and every
publish will fail with COMPILER_DRIFT.
"""

from __future__ import annotations

import pytest

from app.layout.canonical import canonicalize, format_number, sha256_hex


class TestFormatNumber:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (0, "0"),
            (1, "1"),
            (-1, "-1"),
            (1.5, "1.5"),
            (2.7, "2.7"),
            (0.1 + 0.2, "0.3"),
            (1 / 3, "0.333333"),
            (2 / 3, "0.666667"),
            (1e-6, "0.000001"),
            (1e-7, "0"),
            (100, "100"),
            (1000.5, "1000.5"),
            (-0.0000001, "0"),
            (5.04, "5.04"),
            (3.672, "3.672"),
            (1e21, "1000000000000000000000"),
            (-1e21, "-1000000000000000000000"),
        ],
    )
    def test_matches_typescript_table(self, value: float, expected: str) -> None:
        assert format_number(value) == expected

    @pytest.mark.parametrize("value", [1e-6, 1e-5, 1e21, 1e22, 1e-21, 1234567890123, -1e21])
    def test_never_emits_exponent_notation(self, value: float) -> None:
        assert "e" not in format_number(value).lower()

    @pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
    def test_rejects_non_finite(self, value: float) -> None:
        with pytest.raises(ValueError):
            format_number(value)


class TestCanonicalize:
    def test_sorts_object_keys(self) -> None:
        assert canonicalize({"b": 1, "a": 2}) == '{"a":2,"b":1}'

    def test_is_insensitive_to_key_insertion_order(self) -> None:
        a = {"z": 1, "a": {"y": 2, "b": [{"d": 4, "c": 3}]}}
        b = {"a": {"b": [{"c": 3, "d": 4}], "y": 2}, "z": 1}
        assert canonicalize(a) == canonicalize(b)

    def test_preserves_array_order(self) -> None:
        assert canonicalize([3, 1, 2]) == "[3,1,2]"

    def test_drops_none_members(self) -> None:
        assert canonicalize({"a": 1, "b": None}) == '{"a":1}'

    def test_renders_booleans_and_null(self) -> None:
        assert canonicalize([True, False, None]) == "[true,false,null]"

    def test_does_not_escape_non_ascii(self) -> None:
        assert canonicalize({"n": "ünïcødé"}) == '{"n":"ünïcødé"}'

    def test_normalises_equivalent_float_representations(self) -> None:
        assert canonicalize({"v": 0.1 + 0.2}) == canonicalize({"v": 0.3})

    def test_treats_integers_and_floats_alike(self) -> None:
        # JSON 40 parses to int in Python and to a double in JS; both must hash the same.
        assert canonicalize({"v": 40}) == canonicalize({"v": 40.0})


class TestSha256:
    def test_known_digests(self) -> None:
        assert sha256_hex("") == (
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        assert sha256_hex("abc") == (
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )

    @pytest.mark.parametrize("length", [54, 55, 56, 57, 63, 64, 65, 1000])
    def test_padding_boundaries(self, length: int) -> None:
        # Same lengths as the TypeScript test; cross-checked against node:crypto there.
        digest = sha256_hex("a" * length)
        assert len(digest) == 64
        assert digest == digest.lower()
