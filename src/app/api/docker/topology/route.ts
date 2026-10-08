// src/app/api/docker/topology/route.ts
import { NextResponse } from 'next/server';
import Docker from 'dockerode';
import type { Edge } from '@xyflow/react';
import type { ImageNodeData } from '@/components/graph/nodes/ImageNode';

// Connect to standard local Docker socket
const docker = new Docker({
  socketPath:
    process.platform === 'win32'
      ? '//./pipe/docker_engine'
      : '/var/run/docker.sock',
});

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export async function GET() {
  try {
    // 1. Fetch live containers (all=true gets running + stopped) and local images
    const [containers, images] = await Promise.all([
      docker.listContainers({ all: true }),
      docker.listImages(),
    ]);

    // 2. Map container states per image (keyed by image ID or image repo:tag)
    const imageStats = new Map<
      string,
      {
        imageName: string;
        tag: string;
        imageId: string;
        size: string;
        activeContainers: number;
        inactiveContainers: number;
        containerIds: string[];
      }
    >();

    // Seed from local images list
    for (const img of images) {
      const fullTag = img.RepoTags?.[0] || '<none>:<none>';
      const [imageName, tag = 'latest'] = fullTag.split(':');
      const cleanId = img.Id.replace('sha256:', '').slice(0, 12);

      imageStats.set(img.Id, {
        imageName: imageName === '<none>' ? `image-${cleanId}` : imageName,
        tag,
        imageId: img.Id,
        size: formatBytes(img.Size),
        activeContainers: 0,
        inactiveContainers: 0,
        containerIds: [],
      });
    }

    // Accumulate container states into their respective images
    for (const container of containers) {
      const isRunning = container.State === 'running';
      let entry = imageStats.get(container.ImageID);

      if (!entry) {
        // Fallback for containers whose image tag/ID wasn't returned in listImages
        const [imageName, tag = 'latest'] = container.Image.split(':');
        entry = {
          imageName,
          tag,
          imageId: container.ImageID || container.Image,
          size: 'Unknown',
          activeContainers: 0,
          inactiveContainers: 0,
          containerIds: [],
        };
        imageStats.set(container.ImageID || container.Image, entry);
      }

      if (isRunning) {
        entry.activeContainers += 1;
      } else {
        entry.inactiveContainers += 1;
      }
      entry.containerIds.push(container.Id);
    }

    // 3. Transform image records into positioned React Flow nodes
    const nodes: Array<{
      id: string;
      type: 'imageNode';
      position: { x: number; y: number };
      data: ImageNodeData;
    }> = [];
    const entries = Array.from(imageStats.values());

    const COLUMNS = 3;
    const X_GAP = 320;
    const Y_GAP = 220;

    entries.forEach((stat, index) => {
      const col = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);

      nodes.push({
        id: `img-${stat.imageId.slice(0, 12)}`,
        type: 'imageNode',
        position: { x: 80 + col * X_GAP, y: 100 + row * Y_GAP },
        data: {
          id: `img-${stat.imageId.slice(0, 12)}`,
          position: { x: 80 + col * X_GAP, y: 100 + row * Y_GAP },
          data: {
            imageName: stat.imageName,
            tag: stat.tag,
            imageId: stat.imageId,
            activeContainers: stat.activeContainers,
            inactiveContainers: stat.inactiveContainers,
            size: stat.size,
          },
          imageName: stat.imageName,
          tag: stat.tag,
          imageId: stat.imageId,
          activeContainers: stat.activeContainers,
          inactiveContainers: stat.inactiveContainers,
          size: stat.size,
        },
      });
    });

    // 4. Edges can represent shared Docker networks or Compose links (empty by default)
    const edges: Edge[] = [];

    return NextResponse.json({
      nodes,
      edges,
      summary: {
        totalImages: entries.length,
        totalContainers: containers.length,
        runningContainers: containers.filter((c) => c.State === 'running').length,
      },
    });
  } catch (error: any) {
    console.error('Docker socket query failed:', error);
    return NextResponse.json(
      {
        error: 'Failed to query Docker daemon. Ensure Docker is running.',
        details: error?.message,
      },
      { status: 500 }
    );
  }
}