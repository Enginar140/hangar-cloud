"""Parameter descriptions: parsing ArduPilot's metadata, picking the release, the cache."""

import json

import pytest

from hangar_cloud import params

PDEF = b"""<?xml version="1.0" encoding="utf-8"?>
<paramfile>
  <vehicles>
    <parameters name="ArduCopter">
      <param humanName="Flight Mode 1" name="ArduCopter:FLTMODE1" documentation="Mode for position 1" user="Standard">
        <values><value code="0">Stabilize</value><value code="6">RTL</value></values>
      </param>
    </parameters>
  </vehicles>
  <libraries>
    <parameters name="WP_">
      <param humanName="Waypoint speed" name="WP_SPD" documentation="Horizontal speed" user="Advanced">
        <field name="Units">m/s</field>
        <field name="Range">0.1 20</field>
        <field name="Increment">0.5</field>
        <field name="RebootRequired">True</field>
      </param>
      <param humanName="Options" name="WP_OPTIONS" documentation="Bits">
        <bitmask><bit code="0">First</bit><bit code="2">Third</bit></bitmask>
      </param>
    </parameters>
  </libraries>
</paramfile>
"""

LISTING = '<a href="stable-4.6.3/">x</a><a href="stable-4.7.0/">x</a><a href="stable-4.7.1/">x</a>'


def test_parse_metadata():
    p = params.parse_pdef(PDEF)
    assert p["FLTMODE1"] == {"n": "Flight Mode 1", "d": "Mode for position 1", "v": {"0": "Stabilize", "6": "RTL"}}
    assert p["WP_SPD"] == {"n": "Waypoint speed", "d": "Horizontal speed", "adv": 1, "u": "m/s", "r": [0.1, 20.0],
                           "i": 0.5, "rb": 1}
    assert p["WP_OPTIONS"]["b"] == {"0": "First", "2": "Third"}


def test_pick_the_closest_release():
    assert params.pick_version(LISTING, "4.7.2") == "4.7.1"  # newest published, not newer than the vehicle
    assert params.pick_version(LISTING, "4.7.0") == "4.7.0"
    assert params.pick_version(LISTING, "4.6.9") == "4.6.3"
    assert params.pick_version(LISTING, "4.8.0") is None  # another major.minor: use the latest list


def test_download_once_then_cached(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    asked = []

    def fake_get(url):
        asked.append(url)
        return LISTING.encode() if url.endswith("/Copter/") else PDEF

    monkeypatch.setattr(params, "_get", fake_get)
    assert params.cached("copter", "4.7.2") is None
    data = params.download("copter", "4.7.2")
    assert asked[-1].endswith("/versioned/Copter/stable-4.7.1/apm.pdef.xml")
    assert data["release"] == "4.7.1" and "WP_SPD" in data["params"]
    assert params.cached("copter", "4.7.2") == json.loads(json.dumps(data))
    params.download("boat", None)  # boats run Rover; no version: the latest list
    assert asked[-1] == f"{params.BASE}/Rover/apm.pdef.xml"
    with pytest.raises(ValueError):
        params.firmware("blimp")
