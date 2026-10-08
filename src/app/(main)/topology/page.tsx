// src/app/(main)/graph/page.tsx
'use client';

import React, { useMemo, useEffect, useState, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type NodeTypes,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { RefreshCw, AlertCircle } from 'lucide-react';

import { ImageNode, type ImageNodeData } from '@/components/graph/nodes/ImageNode';

export default function GraphPage() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const nodeTypes = useMemo<NodeTypes>(
    () => ({ imageNode: ImageNode as NodeTypes[string] }),
    [],
  );

  const fetchTopology = useCallback(async () => {
    try {
      const res = await fetch('/radion/api/docker/topology');
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to fetch topology');
      }
      const data = await res.json();
      setNodes(data.nodes);
      setEdges(data.edges);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Error connecting to Docker engine');
    } finally {
      setLoading(false);
    }
  }, [setNodes, setEdges]);

  // Initial load
  useEffect(() => {
    fetchTopology();
  }, [fetchTopology]);

  // Periodic polling every 5 seconds to reflect live container start/stop events
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchTopology, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchTopology]);

  return (
    <div className="h-screen w-full bg-zinc-950 flex flex-col text-zinc-100">
      {/* Header Bar */}
      <header className="h-14 border-b border-zinc-800 px-6 flex items-center justify-between bg-zinc-900/60 backdrop-blur-md z-10">
        <div>
          <h1 className="text-sm font-semibold tracking-tight text-zinc-100">
            Docker Image Topology
          </h1>
          <p className="text-xs text-zinc-400">
            Live container state from Docker daemon
          </p>
        </div>

        {/* Legend & Controls */}
        <div className="flex items-center gap-6 text-xs font-medium">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-zinc-300">Active</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="text-zinc-300">Inactive</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-zinc-600" />
              <span className="text-zinc-400">Dormant</span>
            </div>
          </div>

          <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
            <label className="flex items-center gap-2 cursor-pointer text-zinc-400 hover:text-zinc-200">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-0"
              />
              <span>Live Poll (5s)</span>
            </label>

            <button
              onClick={fetchTopology}
              disabled={loading}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </header>

      {/* Canvas / Error Alert */}
      <main className="flex-1 w-full h-full relative">
        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-rose-950/80 border border-rose-500/50 text-rose-200 px-4 py-2 rounded-lg text-xs backdrop-blur-sm shadow-xl">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          className="bg-zinc-950"
        >
          <Background
            color="#27272a"
            gap={20}
            size={1.5}
            variant={BackgroundVariant.Dots}
          />
          <Controls className="!bg-zinc-900 !border-zinc-800 !text-zinc-300 [&>button]:!border-zinc-800 [&>button]:hover:!bg-zinc-800" />
          <MiniMap
            nodeStrokeWidth={3}
            nodeColor={(node) => {
              const data = node.data as unknown as ImageNodeData | undefined;
              if (data && data.activeContainers > 0) return '#10b981';
              if (data && data.inactiveContainers > 0) return '#f59e0b';
              return '#52525b';
            }}
            maskColor="rgba(9, 9, 11, 0.75)"
            className="!bg-zinc-900 !border-zinc-800 rounded-lg overflow-hidden"
          />
        </ReactFlow>
      </main>
    </div>
  );
}