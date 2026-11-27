# The hos daemon owns every chat; T3 Code and Paseo are only code to copy

The daemon starts, drives, suspends and resumes every Claude and Codex process itself. This is what lets it enforce context handoffs, taint, lanes and spawn limits. Running T3 Code or Paseo as the body and orchestrating it through their MCP would cap hos at their architecture: T3 has no plugin API and isn't taking big features, and neither has lineage, a blackboard or taint. Their MIT/Apache-2.0 code (drivers, event timeline, terminal and diff panes, mobile layout) is copied freely with attribution.
