import { createOSMStream } from "osm-pbf-parser-node";
import type { OsmNode, OsmSource, OsmWay } from "./types";

const WAY_TAGS = ["highway", "oneway", "junction", "access", "motor_vehicle", "motorcar", "area"];

/** Reads an .osm.pbf extract twice (ways, then nodes). Node.js only. */
export function pbfSource(file: string): OsmSource {
  return {
    async *ways() {
      for await (const item of createOSMStream(file, { withTags: { node: false, way: WAY_TAGS, relation: false } })) {
        const entity = item as { type?: string };
        if (entity.type === "way") yield item as OsmWay;
      }
    },
    async *nodes() {
      for await (const item of createOSMStream(file, { withTags: { node: ["highway"], way: false, relation: false } })) {
        const entity = item as { type?: string };
        if (entity.type === "node") yield item as OsmNode;
      }
    },
  };
}
