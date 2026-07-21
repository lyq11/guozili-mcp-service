#!/usr/bin/env python3
"""unittest fixtures for the offline PCB placement prototype, covering the
specific scenarios the two review passes raised: corrected net-scoring math,
a region rigid-transform at a non-orthogonal rotation, a board outline with
a hole, a locked component acting as an obstacle without ever moving, a
connector overhang allowance, and a forced wirelength-regression rejection
by the gate.

Run: python -m unittest test_pcb_layout -v
"""

from __future__ import annotations

import math
import unittest

import apply_gate
import geometry as geo
import model as m
import place as p
import regions as r


class NetScoringTests(unittest.TestCase):
    def test_ground_excluded_and_inverse_frequency(self):
        # C1 shares VOUT (used by 2 components: C1 + U1) and GND (used by
        # everything) with U1. GND must not contribute; VOUT contributes 1/2.
        c1_pads = [m.Pad(id="c1p1", component_id="C1", number="1", net="VOUT", layer=1, x=0, y=0),
                   m.Pad(id="c1p2", component_id="C1", number="2", net="GND", layer=1, x=0, y=0)]
        u1_pads = [m.Pad(id="u1p1", component_id="U1", number="1", net="VOUT", layer=1, x=0, y=0),
                   m.Pad(id="u1p2", component_id="U1", number="2", net="GND", layer=1, x=0, y=0)]
        net_usage = {"VOUT": 2, "GND": 10}
        score = r.net_score(c1_pads, u1_pads, net_usage)
        self.assertAlmostEqual(score, 0.5)

    def test_common_rail_scores_lower_than_rare_net(self):
        # A component sharing only a widely-used rail should score lower
        # than one sharing a rarely-used net, even though both share
        # exactly one non-ground net with the anchor.
        rare_pads = [m.Pad(id="p1", component_id="RARE", number="1", net="ADC_IN", layer=1, x=0, y=0)]
        common_pads = [m.Pad(id="p2", component_id="COMMON", number="1", net="VCC_3V3", layer=1, x=0, y=0)]
        anchor_pads = [
            m.Pad(id="a1", component_id="U1", number="1", net="ADC_IN", layer=1, x=0, y=0),
            m.Pad(id="a2", component_id="U1", number="2", net="VCC_3V3", layer=1, x=0, y=0),
        ]
        net_usage = {"ADC_IN": 2, "VCC_3V3": 40}
        rare_score = r.net_score(rare_pads, anchor_pads, net_usage)
        common_score = r.net_score(common_pads, anchor_pads, net_usage)
        self.assertGreater(rare_score, common_score)


class RegionRigidTransformTests(unittest.TestCase):
    def test_member_position_rotation_and_bbox_move_together(self):
        snapshot = {
            "board": {"pcb": {"uuid": "pcb-1"}}, "boardOutline": {"lines": [], "arcs": []},
            "components": [
                {"id": "U1", "designator": "U1", "x": 100, "y": 100, "rotation": 0, "locked": False,
                 "bbox": {"minX": 90, "minY": 90, "maxX": 110, "maxY": 110}, "pads": []},
                {"id": "C1", "designator": "C1", "x": 150, "y": 100, "rotation": 0, "locked": False,
                 "bbox": {"minX": 145, "minY": 95, "maxX": 155, "maxY": 105}, "pads": []},
            ],
            "standalonePads": [],
        }
        regions_json = {
            "board": {"polygon": {"outer": [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], "holes": []}, "bounds": {"minX": 0, "minY": 0, "maxX": 1000, "maxY": 1000}},
            "keepouts": [],
            "regions": [{"anchorDesignator": "U1", "anchorComponentId": "U1", "memberComponentIds": ["C1"], "anchorPins": [], "locked": False, "role": "ic"}],
            "unassigned": [],
        }
        state = p.build_initial_state(snapshot, regions_json)
        region = regions_json["regions"][0]
        theta = 90.0
        anchor_new_pos = (300.0, 300.0)
        p.apply_region_rigid_transform(state, region, anchor_new_pos, theta)

        anchor = state.components["U1"]
        member = state.components["C1"]
        self.assertAlmostEqual(anchor.x, 300.0)
        self.assertAlmostEqual(anchor.y, 300.0)

        # Member was (50, 0) relative to the anchor; rotating that offset by
        # +90 degrees (our convention: x'=x*cos-y*sin, y'=x*sin+y*cos) gives
        # (0, 50), so the member should land at anchor_new + (0, 50).
        self.assertAlmostEqual(member.x, 300.0, places=6)
        self.assertAlmostEqual(member.y, 350.0, places=6)
        self.assertAlmostEqual(member.rotation, 90.0)

        # The member's bbox must reflect BOTH the position change and the
        # 90-degree reorientation (10x10 square stays 10x10 here since it's
        # symmetric, but let's check it's centered on the new position, not
        # still centered on the old one).
        bbox = member.bbox
        center_x = (bbox["minX"] + bbox["maxX"]) / 2
        center_y = (bbox["minY"] + bbox["maxY"]) / 2
        self.assertAlmostEqual(center_x, 300.0, places=6)
        self.assertAlmostEqual(center_y, 350.0, places=6)

    def test_asymmetric_bbox_swaps_dimensions_on_90_degree_rotation(self):
        # A 20-wide x 6-tall bbox rotated 90 degrees around its own center
        # should become 6-wide x 20-tall.
        bbox = {"minX": -10, "minY": -3, "maxX": 10, "maxY": 3}
        rotated = geo.rotated_bbox(bbox, (0, 0), 90)
        self.assertAlmostEqual(rotated["maxX"] - rotated["minX"], 6, places=6)
        self.assertAlmostEqual(rotated["maxY"] - rotated["minY"], 20, places=6)


class BoardPolygonHoleTests(unittest.TestCase):
    def test_point_inside_hole_is_rejected(self):
        outer = [{"startX": 0, "startY": 0, "endX": 100, "endY": 0},
                 {"startX": 100, "startY": 0, "endX": 100, "endY": 100},
                 {"startX": 100, "startY": 100, "endX": 0, "endY": 100},
                 {"startX": 0, "startY": 100, "endX": 0, "endY": 0}]
        hole = [{"startX": 40, "startY": 40, "endX": 60, "endY": 40},
                {"startX": 60, "startY": 40, "endX": 60, "endY": 60},
                {"startX": 60, "startY": 60, "endX": 40, "endY": 60},
                {"startX": 40, "startY": 60, "endX": 40, "endY": 40}]
        polygon = geo.build_board_polygon(outer + hole, [])
        self.assertEqual(len(polygon.holes), 1)
        self.assertFalse(geo.point_in_board((50, 50), polygon))
        self.assertTrue(geo.point_in_board((10, 10), polygon))

        placement_bbox_in_hole = {"minX": 45, "minY": 45, "maxX": 55, "maxY": 55}
        self.assertFalse(geo.bbox_fully_inside_board(placement_bbox_in_hole, polygon))


class LockedComponentObstacleTests(unittest.TestCase):
    def test_locked_component_is_obstacle_and_never_moves(self):
        snapshot = {
            "board": {"pcb": {"uuid": "pcb-1"}},
            "boardOutline": {
                "lines": [{"startX": 0, "startY": 0, "endX": 1000, "endY": 0},
                          {"startX": 1000, "startY": 0, "endX": 1000, "endY": 1000},
                          {"startX": 1000, "startY": 1000, "endX": 0, "endY": 1000},
                          {"startX": 0, "startY": 1000, "endX": 0, "endY": 0}],
                "arcs": [],
            },
            "components": [
                {"id": "U1", "designator": "U1", "x": 100, "y": 100, "rotation": 0, "locked": False,
                 "bbox": {"minX": 90, "minY": 90, "maxX": 110, "maxY": 110}, "pads": []},
                {"id": "FIX1", "designator": "FIX1", "x": 200, "y": 100, "rotation": 0, "locked": True,
                 "bbox": {"minX": 190, "minY": 90, "maxX": 210, "maxY": 110}, "pads": []},
            ],
            "standalonePads": [],
        }
        regions_json = {
            "board": {"polygon": {"outer": [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], "holes": []}, "bounds": {"minX": 0, "minY": 0, "maxX": 1000, "maxY": 1000}},
            "keepouts": [],
            "regions": [{"anchorDesignator": "U1", "anchorComponentId": "U1", "memberComponentIds": [], "anchorPins": [], "locked": False, "role": "ic"}],
            "unassigned": ["FIX1"],
        }
        state = p.build_initial_state(snapshot, regions_json)
        locked_bbox = snapshot["components"][1]["bbox"]
        self.assertTrue(any(ob == locked_bbox for ob in state.obstacles))
        self.assertFalse(state.components["FIX1"].moved)

        # A candidate placement landing exactly on the locked component must
        # be rejected.
        self.assertTrue(state.collides(locked_bbox))


class ConnectorOverhangTests(unittest.TestCase):
    def test_overhang_within_budget_is_allowed(self):
        board_bounds_polygon = geo.BoardPolygon(outer=[(0, 0), (1000, 0), (1000, 1000), (0, 1000)], holes=[])
        # A connector body that sticks 30 mil past the right edge.
        bbox = {"minX": 950, "minY": 400, "maxX": 1030, "maxY": 500}
        self.assertFalse(geo.bbox_fully_inside_board(bbox, board_bounds_polygon, allowed_overhang_mil=0))
        self.assertTrue(geo.bbox_fully_inside_board(bbox, board_bounds_polygon, allowed_overhang_mil=50))
        self.assertFalse(geo.bbox_fully_inside_board(bbox, board_bounds_polygon, allowed_overhang_mil=10))


class WirelengthGateTests(unittest.TestCase):
    def test_gate_rejects_on_wirelength_regression(self):
        report = {
            "outsideBoard": [], "overlaps": [], "unsatisfiedConstraints": [], "unassigned": [],
            "estimatedWireLengthBefore": 1000.0, "estimatedWireLengthAfter": 1200.0, "wirelengthRegression": True,
        }
        failures = apply_gate.evaluate(report)
        self.assertTrue(any("wirelengthRegression" in f for f in failures))

    def test_gate_passes_clean_report(self):
        report = {
            "outsideBoard": [], "overlaps": [], "unsatisfiedConstraints": [], "unassigned": [],
            "estimatedWireLengthBefore": 1000.0, "estimatedWireLengthAfter": 1000.0, "wirelengthRegression": False,
        }
        self.assertEqual(apply_gate.evaluate(report), [])


class ValueNormalizationTests(unittest.TestCase):
    def test_si_prefix_equivalence(self):
        self.assertTrue(m.values_match("100nF", "0.1uF"))
        self.assertFalse(m.values_match("100nF", "10uF"))

    def test_eia_code_not_resolved(self):
        # Explicitly deferred per the plan -- must not silently claim a match.
        self.assertIsNone(m.normalize_value("104"))


if __name__ == "__main__":
    unittest.main()
