'use client';

import React, { memo } from 'react';
import { Handle, Position, NodeProps, XYPosition } from '@xyflow/react';
import { Layers, PlayCircle, StopCircle, Box } from 'lucide-react';

export interface ImageNodeData {
  id: string;
  position: XYPosition;
  data: {
    imageName: string;
    tag: string;
    imageId: string;
    activeContainers: number;
    inactiveContainers: number;
    size?: string;
  };
  sourcePosition?: Position | undefined;
  targetPosition?: Position | undefined;
  imageName: string;
  tag: string;
  imageId: string;
  activeContainers: number;
  inactiveContainers: number;
  // Optional extra metadata
  size?: string;
}

function getImageStyles(active: number, inactive: number, selected?: boolean) {
  // Case 1: Active containers running
  if (active > 0) {
    return {
      border: 'border-emerald-500/60 hover:border-emerald-400',
      glow: selected
        ? 'ring-2 ring-emerald-400 shadow-lg shadow-emerald-950/50'
        : 'shadow-md shadow-emerald-950/30',
      headerBg: 'bg-emerald-950/40 text-emerald-300 border-emerald-500/20',
      indicator: 'bg-emerald-400 animate-pulse',
      statusText: 'Active',
    };
  }

  // Case 2: Only stopped/inactive containers exist
  if (inactive > 0) {
    return {
      border: 'border-amber-500/50 hover:border-amber-400',
      glow: selected
        ? 'ring-2 ring-amber-400 shadow-lg shadow-amber-950/40'
        : 'shadow-md shadow-zinc-950/30',
      headerBg: 'bg-amber-950/20 text-amber-300 border-amber-500/20',
      indicator: 'bg-amber-500',
      statusText: 'Inactive',
    };
  }

  // Case 3: Dormant image (0 active and 0 inactive containers)
  return {
    border: 'border-zinc-700/80 hover:border-zinc-600',
    glow: selected ? 'ring-2 ring-zinc-500' : '',
    headerBg: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/40',
    indicator: 'bg-zinc-600',
    statusText: 'Dormant',
  };
}

export const ImageNode = memo(({ data, selected }: NodeProps<ImageNodeData>) => {
  const colorStyles = getImageStyles(
    data.activeContainers,
    data.inactiveContainers,
    typeof selected === 'boolean' ? selected : undefined
  );

  return (
    <div
      className={`relative min-w-[240px] rounded-xl border bg-zinc-900/95 backdrop-blur-sm transition-all duration-200 ${colorStyles.border} ${colorStyles.glow}`}
    >
      {/* React Flow Connection Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !border-2 !border-zinc-900 !bg-zinc-400"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !border-2 !border-zinc-900 !bg-zinc-400"
      />

      {/* Node Header */}
      <div
        className={`flex items-center justify-between border-b px-3.5 py-2.5 rounded-t-xl ${colorStyles.headerBg}`}
      >
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 shrink-0" />
          <span
            className="font-semibold text-xs tracking-wide truncate max-w-[140px]"
            title={data.imageName}
          >
            {data.imageName}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-400 font-mono">
            {data.tag}
          </span>
        </div>

        {/* Live Status Indicator */}
        <div className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${colorStyles.indicator}`} />
          <span className="text-[10px] font-medium uppercase tracking-wider">
            {colorStyles.statusText}
          </span>
        </div>
      </div>

      {/* Node Body & Stats */}
      <div className="p-3 text-xs text-zinc-300 space-y-2.5">
        <div className="flex items-center justify-between text-[11px] text-zinc-400">
          <span>Image ID</span>
          <span className="font-mono text-zinc-300">
            {data.imageId.slice(0, 12)}
          </span>
        </div>

        {/* Container State Chips */}
        <div className="grid grid-cols-2 gap-2 pt-1">
          {/* Active containers chip */}
          <div
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-[11px] font-medium ${
              data.activeContainers > 0
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                : 'bg-zinc-800/40 border-zinc-800 text-zinc-500'
            }`}
          >
            <PlayCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{data.activeContainers} Active</span>
          </div>

          {/* Inactive containers chip */}
          <div
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-[11px] font-medium ${
              data.inactiveContainers > 0
                ? 'bg-amber-950/30 border-amber-500/25 text-amber-300'
                : 'bg-zinc-800/40 border-zinc-800 text-zinc-500'
            }`}
          >
            <StopCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{data.inactiveContainers} Inactive</span>
          </div>
        </div>

        {data.size && (
          <div className="text-[10px] text-zinc-500 text-right pt-0.5">
            Size: {data.size}
          </div>
        )}
      </div>
    </div>
  );
});

ImageNode.displayName = 'ImageNode';