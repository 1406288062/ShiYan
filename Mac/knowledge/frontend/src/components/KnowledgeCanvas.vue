<template>
  <div ref="viewportRef" class="knowledge-map" :class="{ 'is-focused': selectedModuleId || selectedClusterId }">
    <div class="map-plane" :style="{ width: canvasWidth + 'px', height: planeHeight + 'px' }">
      <button v-if="selectedModuleId || selectedClusterId" class="map-back" type="button" @click="goBack">
        <span aria-hidden="true">←</span> {{ backLabel }}
      </button>

      <svg class="connections" :width="canvasWidth" :height="planeHeight" aria-hidden="true">
        <defs>
          <marker v-for="type in directionalRelationTypes" :id="`arrow-${type}`" :key="type" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L7,3.5 L0,7 Z" :class="`arrow-${type}`" />
          </marker>
        </defs>
        <line
          v-for="line in connectionLines"
          :key="line.key"
          :x1="line.x1"
          :y1="line.y1"
          :x2="line.x2"
          :y2="line.y2"
          :class="[line.type, { 'has-arrow': line.markerEnd }]"
          :marker-end="line.markerEnd || undefined"
        />
      </svg>

      <button
        v-for="node in visibleNodes"
        :key="node.id"
        :data-node-kind="node.kind"
        :data-node-level="node.level"
        type="button"
        :class="[
          'knowledge-node',
          nodeLevelClass(node),
          {
            selected: node.id === selectedModuleId || node.id === selectedClusterId,
            'has-multiple-sources': node.supportCount > 1,
            'is-topic-group': node.kind === 'cluster' || node.kind === 'nav' || node.isNavigationGroup,
            'is-topic': node.kind === 'node' && node.level > 1 && node.children.length > 0
          }
        ]"
        :style="nodeStyle(node)"
        :aria-label="nodeAriaLabel(node)"
        @click="onNodeClick(node)"
      >
        <span class="node-kicker">{{ nodeKicker(node) }}</span>
        <strong class="node-title">{{ node.title }}</strong>
        <span v-if="node.level > 1 && !node.children.length && node.kind !== 'cluster' && node.supportCount > 1" class="node-source-badge">
          <span class="node-source-dot" aria-hidden="true"></span>{{ node.supportCount }} 份资料
        </span>
        <span v-if="node.level > 1 && !node.children.length" class="node-source">{{ sourceLabel(node) }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { escapeHtml } from '../utils/sanitize'

const props = defineProps({
  knowledgeData: { type: Object, default: null }
})

const emit = defineEmits(['node-click'])
const viewportRef = ref(null)
const viewportWidth = ref(960)
const viewportHeight = ref(640)
const selectedModuleId = ref('')
const selectedClusterId = ref('')
const directionalRelationTypes = ['sequence', 'causes', 'depends_on', 'contrasts', 'conflicts', 'updates']
const relationLabels = {
  contains: '包含', sequence: '先后', causes: '因果', depends_on: '依赖',
  contrasts: '对比', conflicts: '冲突', updates: '更新'
}

let resizeObserver = null

const CARD_BOX = {
  root: { width: 210, height: 150 },
  module: { width: 218, height: 136 },
  selectedModule: { width: 224, height: 136 },
  cluster: { width: 220, height: 136 },
  point: { width: 188, height: 116 }
}
const COMPACT_BREAKPOINT = 720
const COMPACT_PADDING = 22
const EDGE_PADDING = 24
const GRID_GAP_X = 26
const GRID_GAP_Y = 24
const MIN_GRID_GAP_X = 14
const MIN_GRID_GAP_Y = 18
const FOCUS_ANCHOR_GAP = 30

const MAX_VISIBLE_CHILDREN = 12

function rawChildren(node, level) {
  if (Array.isArray(node?.children)) return node.children
  if (level === 1 && Array.isArray(node?.level2)) return node.level2
  if (Array.isArray(node?.level3)) return node.level3
  return []
}

function mergedSources(nodes) {
  const result = []
  const seen = new Set()
  nodes.forEach(node => {
    ;(Array.isArray(node?.sources) ? node.sources : []).forEach(source => {
      const key = `${source?.page_start || ''}:${source?.page_end || ''}:${source?.quote || ''}`
      if (seen.has(key)) return
      seen.add(key)
      result.push(source)
    })
  })
  return result
}

function rebalanceRawChildren(values, parentId, parentTitle) {
  const children = Array.isArray(values) ? values.filter(Boolean) : []
  if (children.length <= MAX_VISIBLE_CHILDREN) return children
  const groupCount = Math.min(MAX_VISIBLE_CHILDREN, Math.ceil(children.length / MAX_VISIBLE_CHILDREN))
  const groups = []
  for (let index = 0; index < groupCount; index += 1) {
    const start = Math.round(index * children.length / groupCount)
    const end = Math.round((index + 1) * children.length / groupCount)
    const members = children.slice(start, end)
    if (!members.length) continue
    const firstTitle = String(members[0]?.title || '')
    const lastTitle = String(members[members.length - 1]?.title || '')
    const title = firstTitle && lastTitle && firstTitle !== lastTitle
      ? `${firstTitle} · ${lastTitle}`
      : firstTitle || lastTitle || `${parentTitle}分组 ${index + 1}`
    groups.push({
      id: `client-nav-${parentId}-${index + 1}`,
      title,
      summary: `包含 ${members.length} 项内容`,
      content: '',
      sources: mergedSources(members),
      children: members,
      is_navigation_group: true,
      navigation_only: true
    })
  }
  return groups
}

function rawNodeCategory(node, level) {
  if (node?.is_navigation_group) return 'group'
  return rawChildren(node, level).length ? 'topic' : 'point'
}

function alignSiblingCategories(values, level, parentId) {
  const siblings = Array.isArray(values) ? values.filter(Boolean) : []
  const categories = new Set(siblings.map(node => rawNodeCategory(node, level)))
  if (categories.size < 2) return siblings
  const category = categories.has('group') ? 'group' : 'topic'
  return siblings.map((node, index) => {
    if (rawNodeCategory(node, level) === category) return node
    const originalId = String(node.id || `${level}-${node.title || 'node'}`)
    // Keep the original content node/id reachable below a same-category entry.
    return {
      id: `client-category-${parentId}-${index}-${originalId}`,
      wrapped_node_id: originalId,
      title: node.title,
      summary: node.summary || '',
      sources: Array.isArray(node.sources) ? node.sources : [],
      support_count: node.support_count || 0,
      children: [{ ...node, id: originalId }],
      is_navigation_group: category === 'group',
      navigation_only: true
    }
  })
}

function normalizeNode(node, level, parentId = '') {
  const id = String(node?.id || `${level}-${node?.title || 'node'}`)
  const sourceChildren = rawChildren(node, level)
  const balancedChildren = level === 1
    ? sourceChildren
    : rebalanceRawChildren(sourceChildren, id, String(node?.title || '主题'))
  const children = alignSiblingCategories(balancedChildren, level + 1, id)
    .map(child => normalizeNode(child, level + 1, id))
  return {
    id,
    parentId,
    sourceNodeId: String(node?.wrapped_node_id || id),
    level,
    kind: level === 1 ? 'root' : (node?.is_navigation_group ? 'nav' : 'node'),
    isNavigationGroup: Boolean(node?.is_navigation_group),
    navigationOnly: Boolean(node?.navigation_only),
    title: String(node?.title || '未命名内容'),
    summary: String(node?.summary || ''),
    content: String(node?.content || ''),
    sources: Array.isArray(node?.sources) ? node.sources : [],
    supportCount: Number(node?.support_count || 0),
    children
  }
}

const rootNode = computed(() => {
  const root = props.knowledgeData?.structure?.level1
  return root ? normalizeNode(root, 1) : null
})

function firstSourcePage(node) {
  const pages = []
  const collect = source => {
    const page = Number(source?.page_start || 0)
    if (page > 0) pages.push(page)
  }
  node.sources.forEach(collect)
  node.children.forEach(child => child.sources.forEach(collect))
  return pages.length ? Math.min(...pages) : Number.POSITIVE_INFINITY
}

const modules = computed(() => {
  const values = rootNode.value?.children || []
  return values
    .map((node, sourceIndex) => ({ node, sourceIndex }))
    .sort((left, right) => (
      firstSourcePage(left.node) - firstSourcePage(right.node)
      || left.sourceIndex - right.sourceIndex
    ))
    .map(item => item.node)
})

const allNodes = computed(() => {
  const result = []
  const visit = node => {
    if (!node) return
    result.push(node)
    node.children.forEach(visit)
  }
  visit(rootNode.value)
  return result
})
const nodeById = computed(() => new Map(allNodes.value.map(node => [node.id, node])))

const AUTO_CLUSTER_THRESHOLD = 12
const AUTO_CLUSTER_SIZE = 8

const backendClusters = computed(() => {
  const values = props.knowledgeData?.clusters
  if (!Array.isArray(values)) return []
  return values.map(normalizeCluster)
})

function modulePageBounds(module) {
  const pages = []
  const collect = source => {
    const start = Number(source?.page_start || 0)
    const end = Number(source?.page_end || start || 0)
    if (start > 0) pages.push(start)
    if (end > 0) pages.push(end)
  }
  module.sources.forEach(collect)
  module.children.forEach(child => child.sources.forEach(collect))
  return pages.length
    ? { start: Math.min(...pages), end: Math.max(...pages) }
    : { start: 0, end: 0 }
}

const autoClusters = computed(() => {
  if (backendClusters.value.length || modules.value.length <= AUTO_CLUSTER_THRESHOLD) return []
  const values = []
  const groupSize = Math.max(AUTO_CLUSTER_SIZE, Math.ceil(modules.value.length / MAX_VISIBLE_CHILDREN))
  for (let index = 0; index < modules.value.length; index += groupSize) {
    const group = modules.value.slice(index, index + groupSize)
    const bounds = group.map(modulePageBounds).filter(item => item.start > 0)
    const pageStart = bounds.length ? Math.min(...bounds.map(item => item.start)) : 0
    const pageEnd = bounds.length ? Math.max(...bounds.map(item => item.end)) : 0
    const pointCount = group.reduce((sum, module) => sum + module.children.length, 0)
    const pageLabel = pageStart
      ? (pageEnd > pageStart ? `第 ${pageStart}–${pageEnd} 页` : `第 ${pageStart} 页`)
      : `原文顺序 ${index + 1}–${index + group.length}`
    const firstTitle = group[0]?.title || '未命名主题'
    const lastTitle = group[group.length - 1]?.title || firstTitle
    const semanticRange = firstTitle === lastTitle ? firstTitle : `${firstTitle} → ${lastTitle}`
    const chapterNo = String(values.length + 1).padStart(2, '0')
    values.push({
      id: `auto-cluster-${index + 1}`, level: 2, kind: 'cluster', auto: true, chapterNo,
      title: semanticRange, summary: `${pageLabel} · ${group.length} 个主题 · ${pointCount} 个下级节点`,
      content: '', sources: [], supportCount: group.length, children: [],
      moduleIds: group.map(module => module.id), moduleTitles: group.map(module => module.title),
      documentNames: [], preview: group.slice(0, 3).map(module => module.title).join(' · ')
    })
  }
  return values
})

const clusters = computed(() => backendClusters.value.length ? backendClusters.value : autoClusters.value)
const clusterMode = computed(() => clusters.value.length > 0)
const selectedCluster = computed(() => clusters.value.find(cluster => cluster.id === selectedClusterId.value) || null)
const clusterModules = computed(() => {
  if (!selectedCluster.value) return []
  const moduleIds = new Set(selectedCluster.value.moduleIds)
  return modules.value.filter(module => moduleIds.has(module.id) || moduleIds.has(module.sourceNodeId))
})
const overviewNodes = computed(() => clusterMode.value ? clusters.value : modules.value)
const selectedModule = computed(() => nodeById.value.get(selectedModuleId.value) || null)
const selectedPoints = computed(() => selectedModule.value?.children || [])
const selectedParent = computed(() => selectedModule.value?.parentId ? nodeById.value.get(selectedModule.value.parentId) : null)
const backLabel = computed(() => {
  if (selectedModule.value) {
    if (selectedParent.value && selectedParent.value.level > 1) return `返回${selectedParent.value.title}`
    if (selectedCluster.value) return '返回主题组'
    return '返回知识总览'
  }
  if (selectedCluster.value) return '返回知识总览'
  return ''
})

const visibleNodes = computed(() => {
  if (!rootNode.value) return []
  if (selectedModule.value) {
    const nodes = [selectedModule.value, ...selectedPoints.value]
    return selectedCluster.value ? nodes.map(node => ({ ...node, level: node.level + 1 })) : nodes
  }
  // Clusters add a navigation level above the original document modules.
  if (selectedCluster.value) return [selectedCluster.value, ...clusterModules.value.map(node => ({ ...node, level: node.level + 1 }))]
  return [rootNode.value, ...overviewNodes.value]
})

const layoutGeometry = computed(() => buildLayout())
const canvasWidth = computed(() => layoutGeometry.value.width)
const planeHeight = computed(() => layoutGeometry.value.height)
const positions = computed(() => layoutGeometry.value.positions)

const dataRelations = computed(() => Array.isArray(props.knowledgeData?.relations) ? props.knowledgeData.relations : [])

const connectionLines = computed(() => {
  const root = rootNode.value
  if (!root) return []
  if (!selectedModule.value && !selectedCluster.value && !positions.value[root.id]) return []

  const lines = []
  if (selectedModule.value) {
    // In topic focus only the selected topic owns its level-3 knowledge points.
    selectedPoints.value.forEach(point => addLine(lines, selectedModule.value.id, point.id, 'point-line'))
  } else if (selectedCluster.value) {
    clusterModules.value.forEach(module => addLine(lines, selectedCluster.value.id, module.id, 'cluster-line'))
  } else if (overviewNodes.value.length <= 20) {
    overviewNodes.value.forEach(node => addLine(lines, root.id, node.id, clusterMode.value ? 'cluster-line' : 'module-line'))
  }

  const visibleNodeById = new Map(visibleNodes.value.map(node => [node.id, node]))
  const seen = new Set(lines.map(line => line.key))
  dataRelations.value.forEach(relation => {
    if (relation.type === 'contains') return
    const fromNode = visibleNodeById.get(relation.from)
    const toNode = visibleNodeById.get(relation.to)
    if (!fromNode || !toNode) return
    if (fromNode.level === 1 || toNode.level === 1) return

    const key = `relation:${relation.id}:${relation.from}:${relation.to}`
    if (seen.has(key)) return
    seen.add(key)
    addRelationLine(lines, relation)
  })
  return lines
})

function normalizeCluster(cluster) {
  return {
    id: String(cluster?.id || `cluster-${cluster?.title || 'group'}`),
    level: 2,
    kind: 'cluster',
    auto: Boolean(cluster?.auto),
    title: String(cluster?.title || '未命名主题组'),
    summary: String(cluster?.summary || ''),
    content: '',
    sources: [],
    supportCount: Number(cluster?.document_count || 0),
    children: [],
    moduleIds: Array.isArray(cluster?.module_ids) ? cluster.module_ids.map(String) : [],
    moduleTitles: Array.isArray(cluster?.module_titles) ? cluster.module_titles.map(String) : [],
    documentNames: Array.isArray(cluster?.document_names) ? cluster.document_names.map(String) : [],
    preview: String(cluster?.preview || '')
  }
}

function nodeLevelClass(node) {
  if (node?.level === 1) return 'level1'
  return node?.children?.length ? 'level2' : 'level3'
}

function nodeBox(node) {
  if (node?.level === 1) return CARD_BOX.root
  if (node?.kind === 'cluster') return CARD_BOX.cluster
  if (node?.id && node.id === selectedModuleId.value) return CARD_BOX.selectedModule
  if (node?.children?.length) return CARD_BOX.module
  return CARD_BOX.point
}

function oddValuesUpTo(limit) {
  const values = []
  const safeLimit = Math.max(3, limit)
  for (let value = 3; value <= safeLimit; value += 2) values.push(value)
  return values
}

function adaptiveGap(available, count, preferred, minimum) {
  if (count <= 1) return 0
  const candidate = available / (count - 1)
  return Math.max(minimum, Math.min(preferred, candidate))
}

function chooseGridShape(nodes, centerNode, extraHeight = 0) {
  const nodeCount = nodes.length
  const boxes = [centerNode, ...nodes].filter(Boolean).map(nodeBox)
  const cardWidth = Math.max(...boxes.map(box => box.width), 1)
  const cardHeight = Math.max(...boxes.map(box => box.height), 1)
  const searchLimit = Math.max(5, Math.min(15, nodeCount + 3))
  const oddColumns = oddValuesUpTo(searchLimit)
  const oddRows = oddValuesUpTo(searchLimit)
  let best = null

  for (const columns of oddColumns) {
    for (const rows of oddRows) {
      const capacity = columns * rows - 1
      if (capacity < nodeCount) continue

      const widthForGaps = viewportWidth.value - EDGE_PADDING * 2 - columns * cardWidth
      const heightForGaps = viewportHeight.value - EDGE_PADDING * 2 - extraHeight - rows * cardHeight
      const gapX = adaptiveGap(widthForGaps, columns, GRID_GAP_X, MIN_GRID_GAP_X)
      const gapY = adaptiveGap(heightForGaps, rows, GRID_GAP_Y, MIN_GRID_GAP_Y)
      const contentWidth = columns * cardWidth + Math.max(0, columns - 1) * gapX
      const contentHeight = rows * cardHeight + Math.max(0, rows - 1) * gapY
      const requiredWidth = contentWidth + EDGE_PADDING * 2
      const requiredHeight = contentHeight + EDGE_PADDING * 2 + extraHeight
      const overflowWidth = Math.max(0, requiredWidth - viewportWidth.value)
      const overflowHeight = Math.max(0, requiredHeight - viewportHeight.value)
      const unused = capacity - nodeCount
      const area = requiredWidth * requiredHeight
      const score = (
        overflowWidth * 150000
        + overflowHeight * 125000
        + unused * 1000
        + area / 1000
      )
      if (!best || score < best.score) {
        best = {
          columns,
          rows,
          cardWidth,
          cardHeight,
          gapX,
          gapY,
          contentWidth,
          contentHeight,
          requiredWidth,
          requiredHeight,
          score
        }
      }
    }
  }

  const fallbackRows = Math.max(3, nodeCount * 2 + 1)
  return best || {
    columns: 3,
    rows: fallbackRows,
    cardWidth,
    cardHeight,
    gapX: MIN_GRID_GAP_X,
    gapY: MIN_GRID_GAP_Y,
    contentWidth: 3 * cardWidth + 2 * MIN_GRID_GAP_X,
    contentHeight: fallbackRows * cardHeight + Math.max(0, fallbackRows - 1) * MIN_GRID_GAP_Y,
    requiredWidth: 3 * cardWidth + 2 * MIN_GRID_GAP_X + EDGE_PADDING * 2,
    requiredHeight: fallbackRows * cardHeight + Math.max(0, fallbackRows - 1) * MIN_GRID_GAP_Y + EDGE_PADDING * 2 + extraHeight,
    score: Number.POSITIVE_INFINITY
  }
}

function angleFromTopLeft(row, column, centerRow, centerColumn) {
  const dx = column - centerColumn
  const dy = row - centerRow
  const angleFromTop = Math.atan2(dx, -dy)
  const normalizedFromTop = angleFromTop < 0 ? angleFromTop + Math.PI * 2 : angleFromTop
  return (normalizedFromTop + Math.PI / 4) % (Math.PI * 2)
}

function perimeterOrder(row, column, rows, columns) {
  const lastRow = rows - 1
  const lastColumn = columns - 1
  if (row === 0) return column
  if (column === lastColumn) return lastColumn + row
  if (row === lastRow) return lastColumn + lastRow + (lastColumn - column)
  if (column === 0) return lastColumn + lastRow + lastColumn + (lastRow - row)
  return Number.POSITIVE_INFINITY
}

function gridSlots(shape) {
  const centerColumn = (shape.columns - 1) / 2
  const centerRow = (shape.rows - 1) / 2
  const slots = []
  for (let row = 0; row < shape.rows; row += 1) {
    for (let column = 0; column < shape.columns; column += 1) {
      if (row === centerRow && column === centerColumn) continue
      const perimeter = row === 0 || row === shape.rows - 1 || column === 0 || column === shape.columns - 1
      slots.push({
        row,
        column,
        perimeter,
        order: perimeterOrder(row, column, shape.rows, shape.columns),
        angle: angleFromTopLeft(row, column, centerRow, centerColumn),
        distance: Math.hypot(column - centerColumn, row - centerRow)
      })
    }
  }
  return slots
}

function evenlyPick(slots, count) {
  if (count <= 0) return []
  const ordered = [...slots].sort((left, right) => left.order - right.order)
  if (count >= ordered.length) return ordered
  return Array.from({ length: count }, (_, index) => (
    ordered[Math.floor(index * ordered.length / count)]
  ))
}

function chooseSlots(shape, count) {
  const slots = gridSlots(shape)
  const perimeter = slots.filter(slot => slot.perimeter).sort((left, right) => left.order - right.order)
  if (count <= perimeter.length) return evenlyPick(perimeter, count)

  const remaining = slots
    .filter(slot => !slot.perimeter)
    .sort((left, right) => left.distance - right.distance || left.angle - right.angle)
  return [...perimeter, ...remaining.slice(0, count - perimeter.length)]
}

function placeGridOrbit(result, nodes, centerNode, shape, originX, originY) {
  const centerColumn = (shape.columns - 1) / 2
  const centerRow = (shape.rows - 1) / 2
  const stepX = shape.cardWidth + shape.gapX
  const stepY = shape.cardHeight + shape.gapY
  const center = {
    x: originX + shape.cardWidth / 2 + centerColumn * stepX,
    y: originY + shape.cardHeight / 2 + centerRow * stepY
  }
  result[centerNode.id] = center
  const slots = chooseSlots(shape, nodes.length)
  nodes.forEach((node, index) => {
    const slot = slots[index]
    result[node.id] = {
      x: originX + shape.cardWidth / 2 + slot.column * stepX,
      y: originY + shape.cardHeight / 2 + slot.row * stepY
    }
  })
  return center
}

function buildOverviewGridLayout() {
  const result = {}
  const root = rootNode.value
  const nodes = overviewNodes.value

  // Always use an adaptive rectangular grid for the overview.
  // The grid chooses rows/columns from the real viewport size so the current
  // screen is filled efficiently instead of expanding into a circular orbit.
  const shape = chooseGridShape(nodes, root)
  const width = Math.max(viewportWidth.value, shape.requiredWidth, 320)
  const height = Math.max(viewportHeight.value, shape.requiredHeight, 520)
  const originX = (width - shape.contentWidth) / 2
  const originY = (height - shape.contentHeight) / 2
  placeGridOrbit(result, nodes, root, shape, originX, originY)
  return { width, height, positions: result }
}

function buildModuleFocusGridLayout(centerNode, childNodes) {
  const result = {}
  const shape = chooseGridShape(childNodes, centerNode)
  const width = Math.max(viewportWidth.value, shape.requiredWidth, 320)
  const height = Math.max(viewportHeight.value, shape.requiredHeight, 520)
  const originX = (width - shape.contentWidth) / 2
  const originY = (height - shape.contentHeight) / 2
  placeGridOrbit(result, childNodes, centerNode, shape, originX, originY)
  return { width, height, positions: result }
}

function buildClusterFocusGridLayout(centerNode, childNodes) {
  const result = {}
  const shape = chooseGridShape(childNodes, centerNode)
  const width = Math.max(viewportWidth.value, shape.requiredWidth, 320)
  const height = Math.max(viewportHeight.value, shape.requiredHeight, 520)
  const originX = (width - shape.contentWidth) / 2
  const originY = (height - shape.contentHeight) / 2
  placeGridOrbit(result, childNodes, centerNode, shape, originX, originY)
  return { width, height, positions: result }
}

function compactColumns(width, cardWidth) {
  const available = Math.max(1, width - COMPACT_PADDING * 2)
  return Math.max(1, Math.floor((available + GRID_GAP_X) / (cardWidth + GRID_GAP_X)))
}

function placeCompactGrid(result, nodes, width, startY) {
  if (!nodes.length) return { endY: startY, rows: 0 }
  const cardWidth = Math.max(...nodes.map(node => nodeBox(node).width))
  const cardHeight = Math.max(...nodes.map(node => nodeBox(node).height))
  const columns = compactColumns(width, cardWidth)
  const rows = Math.ceil(nodes.length / columns)

  nodes.forEach((node, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    const rowStart = row * columns
    const itemsInRow = Math.min(columns, nodes.length - rowStart)
    const rowWidth = itemsInRow * cardWidth + Math.max(0, itemsInRow - 1) * GRID_GAP_X
    const firstX = width / 2 - rowWidth / 2 + cardWidth / 2
    result[node.id] = {
      x: firstX + column * (cardWidth + GRID_GAP_X),
      y: startY + cardHeight / 2 + row * (cardHeight + GRID_GAP_Y)
    }
  })

  return {
    rows,
    endY: startY + rows * cardHeight + Math.max(0, rows - 1) * GRID_GAP_Y
  }
}

function buildCompactLayout() {
  const result = {}
  const root = rootNode.value
  const centerNode = selectedModule.value || selectedCluster.value
  const childNodes = selectedModule.value
    ? selectedPoints.value
    : selectedCluster.value
      ? clusterModules.value
      : overviewNodes.value
  const showRoot = !selectedModule.value && !selectedCluster.value
  const widest = Math.max(
    showRoot ? nodeBox(root).width : 0,
    centerNode ? nodeBox(centerNode).width : 0,
    ...childNodes.map(node => nodeBox(node).width),
    0
  )
  const width = Math.max(viewportWidth.value, widest + COMPACT_PADDING * 2, 320)
  let cursorY = COMPACT_PADDING

  if (showRoot) {
    const rootBox = nodeBox(root)
    result[root.id] = { x: width / 2, y: cursorY + rootBox.height / 2 }
    cursorY += rootBox.height
  }

  if (centerNode) {
    if (showRoot) cursorY += GRID_GAP_Y
    const centerBox = nodeBox(centerNode)
    result[centerNode.id] = { x: width / 2, y: cursorY + centerBox.height / 2 }
    cursorY += centerBox.height
  }

  if (childNodes.length) {
    cursorY += GRID_GAP_Y
    const grid = placeCompactGrid(result, childNodes, width, cursorY)
    cursorY = grid.endY
  }

  const height = Math.max(viewportHeight.value, cursorY + COMPACT_PADDING)
  return { width, height, positions: result }
}

function buildLayout() {
  if (!rootNode.value) {
    return {
      width: Math.max(viewportWidth.value, 320),
      height: Math.max(viewportHeight.value, 320),
      positions: {}
    }
  }

  if (viewportWidth.value < COMPACT_BREAKPOINT) {
    return buildCompactLayout()
  }
  if (selectedModule.value) {
    return buildModuleFocusGridLayout(selectedModule.value, selectedPoints.value)
  }
  if (selectedCluster.value) {
    return buildClusterFocusGridLayout(selectedCluster.value, clusterModules.value)
  }
  return buildOverviewGridLayout()
}

function addLine(lines, parentId, childId, type) {
  const parent = positions.value[parentId]
  const child = positions.value[childId]
  if (!parent || !child) return
  lines.push({
    key: `tree:${type}:${parentId}:${childId}`,
    from: parentId,
    to: childId,
    x1: parent.x,
    y1: parent.y,
    x2: child.x,
    y2: child.y,
    type
  })
}

function addRelationLine(lines, relation) {
  const from = positions.value[relation.from]
  const to = positions.value[relation.to]
  if (!from || !to) return
  const type = String(relation.type || 'relation').toLowerCase()
  lines.push({
    key: `relation:${relation.id || type + from.x + to.x}`,
    from: relation.from,
    to: relation.to,
    x1: from.x,
    y1: from.y,
    x2: to.x,
    y2: to.y,
    type: `relation-line relation-${type}`,
    markerEnd: directionalRelationTypes.includes(type) ? `url(#arrow-${type})` : ''
  })
}

function nodeStyle(node) {
  const point = positions.value[node.id] || { x: 0, y: 0 }
  const box = nodeBox(node)
  return {
    left: `${point.x}px`,
    top: `${point.y}px`,
    maxHeight: `${box.height}px`,
    overflow: 'hidden'
  }
}

function nodeKicker(node) {
  if (node.level === 1) return '知识总览'
  if (node.kind === 'cluster') return `${node.chapterNo ? node.chapterNo + ' · ' : ''}主题组 · ${node.moduleIds.length} 个主题`
  const order = nodeOrder(node)
  if (node.isNavigationGroup || node.kind === 'nav') {
    const label = `主题组 · ${node.children.length} 项`
    return order ? `${order} · ${label}` : label
  }
  if (node.children.length) {
    const label = `主题 · ${node.children.length} 项`
    return order ? `${order} · ${label}` : label
  }
  return order ? `${order} · 知识点` : '知识点'
}

function nodeOrder(node) {
  if (node.level === 1 || node.kind === 'cluster') return ''
  let siblings = []
  if (selectedCluster.value && selectedCluster.value.moduleIds.includes(node.id)) {
    siblings = clusterModules.value
  } else {
    const parent = node.parentId ? nodeById.value.get(node.parentId) : null
    siblings = parent?.children || modules.value
  }
  const index = siblings.findIndex(item => item.id === node.id)
  return index >= 0 ? String(index + 1).padStart(2, '0') : ''
}

function keywordText(node) {
  const keywords = node.children.map(child => child.title).filter(Boolean).slice(0, 3)
  const suffix = node.children.length > keywords.length ? ' · …' : ''
  return keywords.join(' · ') + suffix
}

function sourceLabel(node) {
  if (node.supportCount > 1) return `${node.supportCount} 份资料共同支持`
  const source = node.sources[0]
  if (source?.page_start) {
    return source.page_end && source.page_end !== source.page_start
      ? `第 ${source.page_start}–${source.page_end} 页`
      : `第 ${source.page_start} 页`
  }
  return source?.document_name || '查看依据'
}

function nodeAriaLabel(node) {
  if (node.kind === 'cluster') return node.auto ? `${node.title}，展开 ${node.moduleIds.length} 个主题` : `${node.title}，展开其中的资料主题`
  if (node.children.length) return `${node.title}，展开 ${node.children.length} 项内容`
  return `${node.title}，查看知识点详情`
}

function onNodeClick(node) {
  if (node.level === 1) {
    resetFocus()
    return
  }
  if (node.kind === 'cluster') {
    selectedModuleId.value = ''
    selectedClusterId.value = selectedClusterId.value === node.id ? '' : node.id
    return
  }
  if (node.children.length) {
    if (selectedModuleId.value === node.id) {
      goBack()
      return
    }
    const belongsToCurrentCluster = selectedCluster.value?.moduleIds.some(id => id === node.id || id === node.sourceNodeId)
    if (node.parentId === rootNode.value?.id && !belongsToCurrentCluster) selectedClusterId.value = ''
    selectedModuleId.value = node.id
    return
  }
  emit('node-click', node.id)
}

function goBack() {
  if (selectedModule.value) {
    const parent = selectedParent.value
    if (parent && parent.level > 1) {
      selectedModuleId.value = parent.id
      return
    }
    selectedModuleId.value = ''
    return
  }
  selectedClusterId.value = ''
}

function resetFocus() {
  selectedModuleId.value = ''
  selectedClusterId.value = ''
}

function relationHtml(id, nodes) {
  const related = dataRelations.value.filter(relation => (
    relation.type !== 'contains'
    && (relation.from === id || relation.to === id)
    && relation.from !== rootNode.value?.id
    && relation.to !== rootNode.value?.id
  ))
  if (!related.length) return ''
  const titleById = new Map(nodes.map(node => [node.id, node.title]))
  const items = related.slice(0, 8).map(relation => {
    const type = String(relation.type || '').toLowerCase()
    const label = props.knowledgeData?.relation_labels?.[type] || relationLabels[type] || type
    const otherId = relation.from === id ? relation.to : relation.from
    const direction = relation.from === id ? '指向' : '来自'
    const source = Array.isArray(relation.sources) ? relation.sources[0] : null
    const page = source?.page_start ? ` · 第 ${source.page_start} 页` : ''
    return `<li><strong>${escapeHtml(label)}</strong> · ${escapeHtml(direction)}「${escapeHtml(titleById.get(otherId) || '相关节点')}」${page}</li>`
  }).join('')
  return `<h3>明确关系</h3><ul>${items}</ul>`
}

function getNodeContent(id) {
  const nodes = [
    ...allNodes.value,
    ...clusters.value
  ].filter(Boolean)
  const node = nodes.find(item => item.id === id)
  if (!node) return ''
  if (node.kind === 'cluster') {
    if (node.auto) {
      const topics = node.moduleTitles.map(name => `<li>${escapeHtml(name)}</li>`).join('')
      return `<h2>${escapeHtml(node.title)}</h2><p>${escapeHtml(node.summary)}</p><p>${escapeHtml(node.preview)}</p><h3>包含主题</h3><ul>${topics}</ul>`
    }
    const documents = node.documentNames.map(name => `<li>${escapeHtml(name)}</li>`).join('')
    return `<h2>${escapeHtml(node.title)}</h2><p>${escapeHtml(node.summary)}</p><h3>包含资料</h3><ul>${documents}</ul>`
  }
  return `<h2>${escapeHtml(node.title)}</h2>${node.content || ''}${relationHtml(node.id, nodes)}`
}

function updateSize() {
  if (!viewportRef.value) return
  viewportWidth.value = viewportRef.value.clientWidth || 960
  viewportHeight.value = viewportRef.value.clientHeight || 640
}

watch(() => props.knowledgeData, () => {
  selectedModuleId.value = ''
  selectedClusterId.value = ''
  nextTick(updateSize)
}, { deep: true })

onMounted(() => {
  updateSize()
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(viewportRef.value)
  } else {
    window.addEventListener('resize', updateSize)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateSize)
})

defineExpose({ getNodeContent, resetFocus })
</script>