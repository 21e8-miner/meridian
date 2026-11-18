"""
Prometheus metrics for the Meridian server. Standard library only.

A tiny registry of counters, gauges and histograms, rendered in Prometheus' text exposition format
(version 0.0.4) by `render()`. server.py serves it at /metrics. Everything is thread-safe: the
server answers requests on many threads at once.

Label values are bounded by design: routes, providers and outcomes are fixed sets, and the only
per-symbol series are for the few dozen symbols that have a live proxy.
"""
from __future__ import annotations

import math
import threading

_lock = threading.Lock()
_metrics: dict[str, "_Metric"] = {}

# request and provider latencies, in seconds
DEFAULT_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


def _esc(v) -> str:
    return str(v).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _num(x: float) -> str:
    if x != x:
        return "NaN"
    if math.isinf(x):
        return "+Inf" if x > 0 else "-Inf"
    if float(x).is_integer() and abs(x) < 1e15:
        return str(int(x))
    return repr(float(x))


def _labels(names: tuple, values: tuple, extra: str = "") -> str:
    parts = [f'{n}="{_esc(v)}"' for n, v in zip(names, values)]
    if extra:
        parts.append(extra)
    return "{" + ",".join(parts) + "}" if parts else ""


class _Metric:
    kind = ""

    def __init__(self, name: str, help: str, labels: tuple = ()):
        self.name, self.help, self.labelnames = name, help, tuple(labels)
        self.values: dict[tuple, object] = {}

    def _key(self, labels: dict) -> tuple:
        if set(labels) != set(self.labelnames):
            raise ValueError(f"{self.name} takes labels {self.labelnames}, got {tuple(labels)}")
        return tuple(str(labels[n]) for n in self.labelnames)

    def head(self) -> list[str]:
        return [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} {self.kind}"]


class Counter(_Metric):
    kind = "counter"

    def inc(self, amount: float = 1.0, **labels):
        if amount < 0:
            raise ValueError("a counter only goes up")
        k = self._key(labels)
        with _lock:
            self.values[k] = self.values.get(k, 0.0) + amount

    def lines(self) -> list[str]:
        return [f"{self.name}{_labels(self.labelnames, k)} {_num(v)}" for k, v in sorted(self.values.items())]


class Gauge(_Metric):
    kind = "gauge"

    def set(self, value: float, **labels):
        k = self._key(labels)
        with _lock:
            self.values[k] = float(value)

    def clear(self):
        with _lock:
            self.values.clear()

    def lines(self) -> list[str]:
        return [f"{self.name}{_labels(self.labelnames, k)} {_num(v)}" for k, v in sorted(self.values.items())]


class Histogram(_Metric):
    kind = "histogram"

    def __init__(self, name: str, help: str, labels: tuple = (), buckets: tuple = DEFAULT_BUCKETS):
        super().__init__(name, help, labels)
        self.buckets = tuple(sorted(buckets))

    def observe(self, value: float, **labels):
        k = self._key(labels)
        with _lock:
            st = self.values.get(k)
            if st is None:
                st = self.values[k] = [[0] * len(self.buckets), 0.0, 0]
            for i, b in enumerate(self.buckets):
                if value <= b:
                    st[0][i] += 1
            st[1] += value
            st[2] += 1

    def lines(self) -> list[str]:
        out = []
        for k, (counts, total, n) in sorted(self.values.items()):
            # (no backslashes inside f-string braces: the server runs on Python 3.9 too)
            for b, c in zip(self.buckets, counts):
                le = 'le="' + _num(b) + '"'
                out.append(f"{self.name}_bucket{_labels(self.labelnames, k, le)} {c}")
            inf = 'le="+Inf"'
            out.append(f"{self.name}_bucket{_labels(self.labelnames, k, inf)} {n}")
            out.append(f"{self.name}_sum{_labels(self.labelnames, k)} {_num(total)}")
            out.append(f"{self.name}_count{_labels(self.labelnames, k)} {n}")
        return out


def _register(m: _Metric) -> _Metric:
    with _lock:
        if m.name in _metrics:
            raise ValueError(f"{m.name} is registered twice")
        _metrics[m.name] = m
    return m


def counter(name, help, labels=()):
    return _register(Counter(name, help, labels))


def gauge(name, help, labels=()):
    return _register(Gauge(name, help, labels))


def histogram(name, help, labels=(), buckets=DEFAULT_BUCKETS):
    return _register(Histogram(name, help, labels, buckets))


_collectors: list = []


def collector(fn):
    """Register a function run just before each scrape, to set gauges that are cheapest to read
    on demand (cache size, how old the live proxies are)."""
    _collectors.append(fn)
    return fn


def render() -> str:
    for fn in _collectors:
        try:
            fn()
        except Exception:  # a broken collector must not take the endpoint down
            pass
    with _lock:
        blocks = [m.head() + m.lines() for _, m in sorted(_metrics.items())]
    return "\n".join(line for block in blocks for line in block) + "\n"


CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
