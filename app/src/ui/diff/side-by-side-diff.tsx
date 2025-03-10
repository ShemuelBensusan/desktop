import * as React from 'react'
import { Repository } from '../../models/repository'
import {
  ITextDiff,
  DiffLineType,
  DiffHunk,
  DiffLine,
  DiffSelection,
  DiffHunkExpansionType,
} from '../../models/diff'
import {
  getLineFilters,
  highlightContents,
  IFileContents,
} from './syntax-highlighting'
import { ITokens, ILineTokens, IToken } from '../../lib/highlighter/types'
import {
  assertNever,
  assertNonNullable,
  forceUnwrap,
} from '../../lib/fatal-error'
import classNames from 'classnames'
import {
  List,
  AutoSizer,
  CellMeasurerCache,
  CellMeasurer,
  ListRowProps,
} from 'react-virtualized'
import { SideBySideDiffRow } from './side-by-side-diff-row'
import memoize from 'memoize-one'
import {
  findInteractiveOriginalDiffRange,
  DiffRangeType,
} from './diff-explorer'
import {
  ChangedFile,
  DiffRow,
  DiffRowType,
  canSelect,
  getDiffTokens,
  SimplifiedDiffRowData,
  SimplifiedDiffRow,
  IDiffRowData,
  DiffColumn,
  getLineWidthFromDigitCount,
  getNumberOfDigits,
} from './diff-helpers'
import { showContextualMenu } from '../main-process-proxy'
import { getTokens } from './diff-syntax-mode'
import { DiffSearchInput } from './diff-search-input'
import { escapeRegExp } from '../../lib/helpers/regex'
import {
  expandTextDiffHunk,
  DiffExpansionKind,
  expandWholeTextDiff,
} from './text-diff-expansion'
import { IMenuItem } from '../../lib/menu-item'

const DefaultRowHeight = 20
const MaxLineLengthToCalculateDiff = 240

export interface ISelectionPoint {
  readonly column: DiffColumn
  readonly row: number
}

export interface ISelection {
  readonly from: ISelectionPoint
  readonly to: ISelectionPoint
  readonly isSelected: boolean
}

type ModifiedLine = { line: DiffLine; diffLineNumber: number }

interface ISideBySideDiffProps {
  readonly repository: Repository

  /** The file whose diff should be displayed. */
  readonly file: ChangedFile

  /** The initial diff */
  readonly diff: ITextDiff

  /**
   * Contents of the old and new files related to the current text diff.
   */
  readonly fileContents: IFileContents | null

  /**
   * Called when the includedness of lines or a range of lines has changed.
   * Only applicable when readOnly is false.
   */
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void

  /**
   * Called when the user wants to discard a selection of the diff.
   * Only applicable when readOnly is false.
   */
  readonly onDiscardChanges?: (
    diff: ITextDiff,
    diffSelection: DiffSelection
  ) => void

  /** Whether or not whitespace changes are hidden. */
  readonly hideWhitespaceInDiff: boolean

  /**
   * Whether we'll show a confirmation dialog when the user
   * discards changes.
   */
  readonly askForConfirmationOnDiscardChanges?: boolean

  /**
   * Whether we'll show the diff in a side-by-side layout.
   */
  readonly showSideBySideDiff: boolean

  /** Called when the user changes the hide whitespace in diffs setting. */
  readonly onHideWhitespaceInDiffChanged: (checked: boolean) => void
}

interface ISideBySideDiffState {
  /** The diff that should be rendered */
  readonly diff: ITextDiff

  /**
   * The list of syntax highlighting tokens corresponding to
   * the previous contents of the file.
   */
  readonly beforeTokens?: ITokens
  /**
   * The list of syntax highlighting tokens corresponding to
   * the next contents of the file.
   */
  readonly afterTokens?: ITokens

  /**
   * Indicates whether the user is doing a text selection and in which
   * column is doing it. This allows us to limit text selection to that
   * specific column via CSS.
   */
  readonly selectingTextInRow?: 'before' | 'after'

  /**
   * The current diff selection. This is used while
   * dragging the mouse over different lines to know where the user started
   * dragging and whether the selection is to add or remove lines from the
   * selection.
   **/
  readonly temporarySelection?: ISelection

  /**
   * Indicates the hunk that the user is currently hovering via the gutter.
   *
   * In this context, a hunk is not exactly equivalent to a diff hunk, but
   * instead marks a group of consecutive added/deleted lines.
   *
   * As an example, the following diff will contain a single diff hunk
   * (marked by the line starting with @@) but in this context we'll have two
   * hunks:
   *
   * |  @@ -1,4 +1,4 @@
   * |  line 1
   * |  -line 2
   * |  +line 2a
   * |  line 3
   * |  -line 4
   * |  +line 4a
   *
   * This differentiation makes selecting multiple lines by clicking on the
   * gutter more user friendly, since only consecutive modified lines get selected.
   */
  readonly hoveredHunk?: number

  readonly isSearching: boolean

  readonly searchQuery?: string

  readonly searchResults?: SearchResults

  readonly selectedSearchResult: number | undefined
}

const listRowsHeightCache = new CellMeasurerCache({
  defaultHeight: DefaultRowHeight,
  fixedWidth: true,
})

export class SideBySideDiff extends React.Component<
  ISideBySideDiffProps,
  ISideBySideDiffState
> {
  private virtualListRef = React.createRef<List>()

  /** Diff to restore when "Collapse all expanded lines" option is used */
  private diffToRestore: ITextDiff | null = null

  public constructor(props: ISideBySideDiffProps) {
    super(props)

    this.state = {
      diff: props.diff,
      isSearching: false,
      selectedSearchResult: undefined,
    }
  }

  public componentDidMount() {
    this.initDiffSyntaxMode()

    window.addEventListener('keydown', this.onWindowKeyDown)

    // Listen for the custom event find-text (see app.tsx)
    // and trigger the search plugin if we see it.
    document.addEventListener('find-text', this.showSearch)
  }

  public componentWillUnmount() {
    window.removeEventListener('keydown', this.onWindowKeyDown)
    document.removeEventListener('mouseup', this.onEndSelection)
    document.removeEventListener('find-text', this.showSearch)
  }

  public componentDidUpdate(
    prevProps: ISideBySideDiffProps,
    prevState: ISideBySideDiffState
  ) {
    if (
      !highlightParametersEqual(this.props, prevProps, this.state, prevState)
    ) {
      this.initDiffSyntaxMode()
      this.clearListRowsHeightCache()
    }

    if (this.props.diff.text !== prevProps.diff.text) {
      this.diffToRestore = null
      this.setState({
        diff: this.props.diff,
      })
    }

    // Scroll to top if we switched to a new file
    if (
      this.virtualListRef.current !== null &&
      this.props.file.id !== prevProps.file.id
    ) {
      this.virtualListRef.current.scrollToPosition(0)
    }
  }

  private canExpandDiff() {
    const contents = this.props.fileContents
    return (
      contents !== null &&
      contents.canBeExpanded &&
      contents.newContents.length > 0
    )
  }

  public render() {
    const { diff } = this.state

    const rows = getDiffRows(
      diff,
      this.props.showSideBySideDiff,
      this.canExpandDiff()
    )
    const containerClassName = classNames('side-by-side-diff-container', {
      'unified-diff': !this.props.showSideBySideDiff,
      [`selecting-${this.state.selectingTextInRow}`]:
        this.props.showSideBySideDiff &&
        this.state.selectingTextInRow !== undefined,
      editable: canSelect(this.props.file),
    })

    return (
      <div className={containerClassName} onMouseDown={this.onMouseDown}>
        {this.state.isSearching && (
          <DiffSearchInput
            onSearch={this.onSearch}
            onClose={this.onSearchCancel}
          />
        )}
        <div className="side-by-side-diff cm-s-default">
          <AutoSizer onResize={this.clearListRowsHeightCache}>
            {({ height, width }) => (
              <List
                deferredMeasurementCache={listRowsHeightCache}
                width={width}
                height={height}
                rowCount={rows.length}
                rowHeight={this.getRowHeight}
                rowRenderer={this.renderRow}
                ref={this.virtualListRef}
                // The following properties are passed to the list
                // to make sure that it gets re-rendered when any of
                // them change.
                isSearching={this.state.isSearching}
                selectedSearchResult={this.state.selectedSearchResult}
                searchQuery={this.state.searchQuery}
                showSideBySideDiff={this.props.showSideBySideDiff}
                beforeTokens={this.state.beforeTokens}
                afterTokens={this.state.afterTokens}
                temporarySelection={this.state.temporarySelection}
                hoveredHunk={this.state.hoveredHunk}
                isSelectable={canSelect(this.props.file)}
                fileSelection={this.getSelection()}
              />
            )}
          </AutoSizer>
        </div>
      </div>
    )
  }

  private renderRow = ({ index, parent, style, key }: ListRowProps) => {
    const { diff } = this.state
    const rows = getDiffRows(
      diff,
      this.props.showSideBySideDiff,
      this.canExpandDiff()
    )
    const row = rows[index]

    if (row === undefined) {
      return null
    }

    const lineNumberWidth = getLineWidthFromDigitCount(
      getNumberOfDigits(diff.maxLineNumber)
    )

    const rowWithTokens = this.createFullRow(row, index)

    const isHunkHovered =
      'hunkStartLine' in row && this.state.hoveredHunk === row.hunkStartLine

    return (
      <CellMeasurer
        cache={listRowsHeightCache}
        columnIndex={0}
        key={key}
        parent={parent}
        rowIndex={index}
      >
        <div key={key} style={style}>
          <SideBySideDiffRow
            row={rowWithTokens}
            lineNumberWidth={lineNumberWidth}
            numRow={index}
            isDiffSelectable={canSelect(this.props.file)}
            isHunkHovered={isHunkHovered}
            showSideBySideDiff={this.props.showSideBySideDiff}
            hideWhitespaceInDiff={this.props.hideWhitespaceInDiff}
            onStartSelection={this.onStartSelection}
            onUpdateSelection={this.onUpdateSelection}
            onMouseEnterHunk={this.onMouseEnterHunk}
            onMouseLeaveHunk={this.onMouseLeaveHunk}
            onExpandHunk={this.onExpandHunk}
            onClickHunk={this.onClickHunk}
            onContextMenuLine={this.onContextMenuLine}
            onContextMenuHunk={this.onContextMenuHunk}
            onContextMenuExpandHunk={this.onContextMenuExpandHunk}
            onContextMenuText={this.onContextMenuText}
            onHideWhitespaceInDiffChanged={
              this.props.onHideWhitespaceInDiffChanged
            }
          />
        </div>
      </CellMeasurer>
    )
  }

  private getRowHeight = (row: { index: number }) => {
    return listRowsHeightCache.rowHeight(row) ?? DefaultRowHeight
  }

  private clearListRowsHeightCache = () => {
    listRowsHeightCache.clearAll()
  }

  private async initDiffSyntaxMode() {
    const contents = this.props.fileContents

    if (contents === null) {
      return
    }

    const { diff: currentDiff } = this.state

    // Store the current props and state so that we can see if anything
    // changes from underneath us as we're making asynchronous
    // operations that makes our data stale or useless.
    const propsSnapshot = this.props
    const stateSnapshot = this.state

    const lineFilters = getLineFilters(currentDiff.hunks)
    const tabSize = 4

    const tokens = await highlightContents(contents, tabSize, lineFilters)

    if (
      !highlightParametersEqual(
        this.props,
        propsSnapshot,
        this.state,
        stateSnapshot
      )
    ) {
      return
    }

    this.setState({
      beforeTokens: tokens.oldTokens,
      afterTokens: tokens.newTokens,
    })
  }

  private getSelection(): DiffSelection | undefined {
    return canSelect(this.props.file) ? this.props.file.selection : undefined
  }

  private createFullRow(row: SimplifiedDiffRow, numRow: number): DiffRow {
    if (row.type === DiffRowType.Added) {
      return {
        ...row,
        data: this.getRowDataPopulated(
          row.data,
          numRow,
          this.props.showSideBySideDiff ? DiffColumn.After : DiffColumn.Before,
          this.state.afterTokens
        ),
      }
    }

    if (row.type === DiffRowType.Deleted) {
      return {
        ...row,
        data: this.getRowDataPopulated(
          row.data,
          numRow,
          DiffColumn.Before,
          this.state.beforeTokens
        ),
      }
    }

    if (row.type === DiffRowType.Modified) {
      return {
        ...row,
        beforeData: this.getRowDataPopulated(
          row.beforeData,
          numRow,
          DiffColumn.Before,
          this.state.beforeTokens
        ),
        afterData: this.getRowDataPopulated(
          row.afterData,
          numRow,
          DiffColumn.After,
          this.state.afterTokens
        ),
      }
    }

    if (row.type === DiffRowType.Context) {
      const lineTokens =
        getTokens(row.beforeLineNumber, this.state.beforeTokens) ??
        getTokens(row.afterLineNumber, this.state.afterTokens)

      const beforeTokens = [...row.beforeTokens]
      const afterTokens = [...row.afterTokens]

      if (lineTokens !== null) {
        beforeTokens.push(lineTokens)
        afterTokens.push(lineTokens)
      }

      const beforeSearchTokens = this.getSearchTokens(numRow, DiffColumn.Before)
      if (beforeSearchTokens !== undefined) {
        beforeSearchTokens.forEach(x => beforeTokens.push(x))
      }

      const afterSearchTokens = this.getSearchTokens(numRow, DiffColumn.After)
      if (afterSearchTokens !== undefined) {
        afterSearchTokens.forEach(x => afterTokens.push(x))
      }

      return { ...row, beforeTokens, afterTokens }
    }

    return row
  }

  private getRowDataPopulated(
    data: SimplifiedDiffRowData,
    row: number,
    column: DiffColumn,
    tokens: ITokens | undefined
  ): IDiffRowData {
    const searchTokens = this.getSearchTokens(row, column)
    const lineTokens = getTokens(data.lineNumber, tokens)
    const finalTokens = [...data.tokens]

    if (searchTokens !== undefined) {
      searchTokens.forEach(x => finalTokens.push(x))
    }
    if (lineTokens !== null) {
      finalTokens.push(lineTokens)
    }

    return {
      ...data,
      tokens: finalTokens,
      isSelected:
        data.diffLineNumber !== null &&
        isInSelection(
          data.diffLineNumber,
          row,
          column,
          this.getSelection(),
          this.state.temporarySelection
        ),
    }
  }

  private getSearchTokens(row: number, column: DiffColumn) {
    const { searchResults: searchTokens, selectedSearchResult } = this.state

    if (searchTokens === undefined) {
      return undefined
    }

    const lineTokens = searchTokens.getLineTokens(row, column)

    if (lineTokens === undefined) {
      return undefined
    }

    if (lineTokens !== undefined && selectedSearchResult !== undefined) {
      const selected = searchTokens.get(selectedSearchResult)

      if (row === selected?.row && column === selected.column) {
        if (lineTokens[selected.offset] !== undefined) {
          const selectedToken = {
            [selected.offset]: { length: selected.length, token: 'selected' },
          }

          return [lineTokens, selectedToken]
        }
      }
    }

    return [lineTokens]
  }

  private getDiffLineNumber(
    rowNumber: number,
    column: DiffColumn
  ): number | null {
    const { diff } = this.state
    const rows = getDiffRows(
      diff,
      this.props.showSideBySideDiff,
      this.canExpandDiff()
    )
    const row = rows[rowNumber]

    if (row === undefined) {
      return null
    }

    if (row.type === DiffRowType.Added || row.type === DiffRowType.Deleted) {
      return row.data.diffLineNumber
    }

    if (row.type === DiffRowType.Modified) {
      return column === DiffColumn.After
        ? row.afterData.diffLineNumber
        : row.beforeData.diffLineNumber
    }

    return null
  }

  /**
   * This handler is used to limit text selection to a single column.
   * To do so, we store the last column where the user clicked and use
   * that information to add a CSS class on the container div
   * (e.g `selecting-before`).
   *
   * Then, via CSS we can disable text selection on the column that is
   * not being selected.
   */
  private onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!this.props.showSideBySideDiff) {
      return
    }

    if (!(event.target instanceof HTMLElement)) {
      return
    }

    // We need to use the event target since the current target will
    // always point to the container.
    const isSelectingBeforeText = event.target.closest('.before')
    const isSelectingAfterText = event.target.closest('.after')

    if (isSelectingBeforeText !== null) {
      this.setState({ selectingTextInRow: 'before' })
    } else if (isSelectingAfterText !== null) {
      this.setState({ selectingTextInRow: 'after' })
    }
  }

  private onStartSelection = (
    row: number,
    column: DiffColumn,
    isSelected: boolean
  ) => {
    const point: ISelectionPoint = { row, column }
    const temporarySelection = { from: point, to: point, isSelected }
    this.setState({ temporarySelection })

    document.addEventListener('mouseup', this.onEndSelection, { once: true })
  }

  private onUpdateSelection = (row: number, column: DiffColumn) => {
    const { temporarySelection } = this.state
    if (temporarySelection === undefined) {
      return
    }

    const to = { row, column }
    this.setState({ temporarySelection: { ...temporarySelection, to } })
  }

  private onEndSelection = () => {
    let selection = this.getSelection()
    const { temporarySelection } = this.state

    if (selection === undefined || temporarySelection === undefined) {
      return
    }

    const { from: tmpFrom, to: tmpTo, isSelected } = temporarySelection

    const fromRow = Math.min(tmpFrom.row, tmpTo.row)
    const toRow = Math.max(tmpFrom.row, tmpTo.row)

    for (let row = fromRow; row <= toRow; row++) {
      const lineBefore = this.getDiffLineNumber(row, tmpFrom.column)
      const lineAfter = this.getDiffLineNumber(row, tmpTo.column)

      if (lineBefore !== null) {
        selection = selection.withLineSelection(lineBefore, isSelected)
      }

      if (lineAfter !== null) {
        selection = selection.withLineSelection(lineAfter, isSelected)
      }
    }

    this.props.onIncludeChanged?.(selection)
    this.setState({ temporarySelection: undefined })
  }

  private onMouseEnterHunk = (hunkStartLine: number) => {
    if (this.state.temporarySelection === undefined) {
      this.setState({ hoveredHunk: hunkStartLine })
    }
  }

  private onMouseLeaveHunk = () => {
    this.setState({ hoveredHunk: undefined })
  }

  private onExpandHunk = (hunkIndex: number, kind: DiffExpansionKind) => {
    const { diff } = this.state

    if (hunkIndex === -1 || hunkIndex >= diff.hunks.length) {
      return
    }

    this.expandHunk(diff.hunks[hunkIndex], kind)
  }

  private onClickHunk = (hunkStartLine: number, select: boolean) => {
    if (this.props.onIncludeChanged === undefined) {
      return
    }

    const { diff } = this.state
    const selection = this.getSelection()

    if (selection !== undefined) {
      const range = findInteractiveOriginalDiffRange(diff.hunks, hunkStartLine)
      if (range !== null) {
        const { from, to } = range
        const sel = selection.withRangeSelection(from, to - from + 1, select)
        this.props.onIncludeChanged(sel)
      }
    }
  }

  /**
   * Handler to show a context menu when the user right-clicks on the diff text.
   */
  private onContextMenuText = () => {
    const selectionLength = window.getSelection()?.toString().length ?? 0

    const items: IMenuItem[] = [
      {
        label: 'Copy',
        // When using role="copy", the enabled attribute is not taken into account.
        role: selectionLength > 0 ? 'copy' : undefined,
        enabled: selectionLength > 0,
      },
    ]

    const expandMenuItem = this.buildExpandMenuItem()
    if (expandMenuItem !== null) {
      items.push({ type: 'separator' }, expandMenuItem)
    }

    showContextualMenu(items)
  }

  /**
   * Handler to show a context menu when the user right-clicks on a line number.
   *
   * @param diffLineNumber the line number the diff where the user clicked
   */
  private onContextMenuLine = (diffLineNumber: number) => {
    const { file, hideWhitespaceInDiff } = this.props
    const { diff } = this.state

    if (!canSelect(file)) {
      return
    }

    if (hideWhitespaceInDiff) {
      return
    }

    if (this.props.onDiscardChanges === undefined) {
      return
    }

    const range = findInteractiveOriginalDiffRange(diff.hunks, diffLineNumber)
    if (range === null || range.type === null) {
      return
    }

    showContextualMenu([
      {
        label: this.getDiscardLabel(range.type, 1),
        action: () => this.onDiscardChanges(diffLineNumber),
      },
    ])
  }

  private buildExpandMenuItem(): IMenuItem | null {
    const { diff } = this.state
    if (!this.canExpandDiff()) {
      return null
    }

    return this.diffToRestore === null
      ? {
          label: __DARWIN__ ? 'Expand Whole File' : 'Expand whole file',
          action: this.onExpandWholeFile,
          // If there is only one hunk that can't be expanded, disable this item
          enabled:
            diff.hunks.length !== 1 ||
            diff.hunks[0].expansionType !== DiffHunkExpansionType.None,
        }
      : {
          label: __DARWIN__
            ? 'Collapse Expanded Lines'
            : 'Collapse expanded lines',
          action: this.onCollapseExpandedLines,
        }
  }

  private onExpandWholeFile = () => {
    const contents = this.props.fileContents
    const { diff } = this.state

    if (contents === null || !this.canExpandDiff()) {
      return
    }

    const updatedDiff = expandWholeTextDiff(diff, contents.newContents)

    if (updatedDiff === undefined) {
      return
    }

    this.diffToRestore = diff

    this.setState({ diff: updatedDiff })
  }

  private onCollapseExpandedLines = () => {
    if (this.diffToRestore === null) {
      return
    }

    this.setState({ diff: this.diffToRestore })

    this.diffToRestore = null
  }

  /**
   * Handler to show a context menu when the user right-clicks on the gutter hunk handler.
   *
   * @param hunkStartLine The start line of the hunk where the user clicked.
   */
  private onContextMenuHunk = (hunkStartLine: number) => {
    if (!canSelect(this.props.file)) {
      return
    }

    if (this.props.onDiscardChanges === undefined) {
      return
    }

    const range = findInteractiveOriginalDiffRange(
      this.state.diff.hunks,
      hunkStartLine
    )
    if (range === null || range.type === null) {
      return
    }

    showContextualMenu([
      {
        label: this.getDiscardLabel(range.type, range.to - range.from + 1),
        action: () => this.onDiscardChanges(range.from, range.to),
      },
    ])
  }

  private onContextMenuExpandHunk = () => {
    const expandMenuItem = this.buildExpandMenuItem()
    if (expandMenuItem === null) {
      return
    }

    showContextualMenu([expandMenuItem])
  }

  private getDiscardLabel(rangeType: DiffRangeType, numLines: number): string {
    const suffix = this.props.askForConfirmationOnDiscardChanges ? '…' : ''
    let type = ''

    if (rangeType === DiffRangeType.Additions) {
      type = __DARWIN__ ? 'Added' : 'added'
    } else if (rangeType === DiffRangeType.Deletions) {
      type = __DARWIN__ ? 'Removed' : 'removed'
    } else if (rangeType === DiffRangeType.Mixed) {
      type = __DARWIN__ ? 'Modified' : 'modified'
    } else {
      assertNever(rangeType, `Invalid range type: ${rangeType}`)
    }

    const plural = numLines > 1 ? 's' : ''
    return __DARWIN__
      ? `Discard ${type} Line${plural}${suffix}`
      : `Discard ${type} line${plural}${suffix}`
  }

  private onDiscardChanges(startLine: number, endLine: number = startLine) {
    const selection = this.getSelection()
    if (selection === undefined) {
      return
    }

    if (this.props.onDiscardChanges === undefined) {
      return
    }

    const newSelection = selection
      .withSelectNone()
      .withRangeSelection(startLine, endLine - startLine + 1, true)

    // Pass the original diff (from props) instead of the (potentially)
    // expanded one.
    this.props.onDiscardChanges(this.props.diff, newSelection)
  }

  private onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      return
    }

    const isCmdOrCtrl = __DARWIN__
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey

    if (isCmdOrCtrl && !event.shiftKey && !event.altKey && event.key === 'f') {
      event.preventDefault()
      this.showSearch()
    }
  }

  private showSearch = () => {
    if (!this.state.isSearching) {
      this.resetSearch(true)
    }
  }

  private onSearch = (searchQuery: string, direction: 'next' | 'previous') => {
    let { selectedSearchResult, searchResults: searchResults } = this.state
    const { showSideBySideDiff } = this.props
    const { diff } = this.state

    // If the query is unchanged and we've got tokens we'll continue, else we'll restart
    if (searchQuery === this.state.searchQuery && searchResults !== undefined) {
      if (selectedSearchResult === undefined) {
        selectedSearchResult = 0
      } else {
        const delta = direction === 'next' ? 1 : -1

        // http://javascript.about.com/od/problemsolving/a/modulobug.htm
        selectedSearchResult =
          (selectedSearchResult + delta + searchResults.length) %
          searchResults.length
      }
    } else {
      searchResults = calcSearchTokens(
        diff,
        showSideBySideDiff,
        searchQuery,
        this.canExpandDiff()
      )
      selectedSearchResult = 0

      if (searchResults === undefined || searchResults.length === 0) {
        this.resetSearch(true)
        return
      }
    }

    const scrollToRow = searchResults.get(selectedSearchResult)?.row

    if (scrollToRow !== undefined) {
      this.virtualListRef.current?.scrollToRow(scrollToRow)
    }

    this.setState({ searchQuery, searchResults, selectedSearchResult })
  }

  private onSearchCancel = () => {
    this.resetSearch(false)
  }

  private resetSearch(isSearching: boolean) {
    this.setState({
      selectedSearchResult: undefined,
      searchQuery: undefined,
      searchResults: undefined,
      isSearching,
    })
  }

  /** Expand a selected hunk. */
  private expandHunk(hunk: DiffHunk, kind: DiffExpansionKind) {
    const contents = this.props.fileContents
    const { diff } = this.state

    if (contents === null || !this.canExpandDiff()) {
      return
    }

    const updatedDiff = expandTextDiffHunk(
      diff,
      hunk,
      kind,
      contents.newContents
    )

    if (updatedDiff === undefined) {
      return
    }

    this.setState({ diff: updatedDiff })
  }
}

/**
 * Checks to see if any key parameters in the props object that are used
 * when performing highlighting has changed. This is used to determine
 * whether highlighting should abort in between asynchronous operations
 * due to some factor (like which file is currently selected) have changed
 * and thus rendering the in-flight highlighting data useless.
 */
function highlightParametersEqual(
  newProps: ISideBySideDiffProps,
  prevProps: ISideBySideDiffProps,
  newState: ISideBySideDiffState,
  prevState: ISideBySideDiffState
) {
  return (
    (newProps === prevProps ||
      (newProps.file.id === prevProps.file.id &&
        newProps.showSideBySideDiff === prevProps.showSideBySideDiff)) &&
    newState.diff.text === prevState.diff.text &&
    prevProps.fileContents?.file.id === newProps.fileContents?.file.id
  )
}

/**
 * Memoized function to calculate the actual rows to display side by side
 * as a diff.
 *
 * @param diff                The diff to use to calculate the rows.
 * @param showSideBySideDiff  Whether or not show the diff in side by side mode.
 */
const getDiffRows = memoize(function (
  diff: ITextDiff,
  showSideBySideDiff: boolean,
  enableDiffExpansion: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  const outputRows = new Array<SimplifiedDiffRow>()

  diff.hunks.forEach((hunk, index) => {
    for (const row of getDiffRowsFromHunk(
      index,
      hunk,
      showSideBySideDiff,
      enableDiffExpansion
    )) {
      outputRows.push(row)
    }
  })

  return outputRows
})

/**
 * Returns an array of rows with the needed data to render a side-by-side diff
 * with them.
 *
 * In some situations it will merge a deleted an added row into a single
 * modified row, in order to display them side by side (This happens when there
 * are consecutive added and deleted rows).
 *
 * @param hunk                The hunk to use to extract the rows data
 * @param showSideBySideDiff  Whether or not show the diff in side by side mode.
 */
function getDiffRowsFromHunk(
  hunkIndex: number,
  hunk: DiffHunk,
  showSideBySideDiff: boolean,
  enableDiffExpansion: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  const rows = new Array<SimplifiedDiffRow>()

  /**
   * Array containing multiple consecutive added/deleted lines. This
   * is used to be able to merge them into modified rows.
   */
  let modifiedLines = new Array<ModifiedLine>()

  for (const [num, line] of hunk.lines.entries()) {
    const diffLineNumber = hunk.unifiedDiffStart + num

    if (line.type === DiffLineType.Delete || line.type === DiffLineType.Add) {
      modifiedLines.push({ line, diffLineNumber })
      continue
    }

    if (modifiedLines.length > 0) {
      // If the current line is not added/deleted and we have any added/deleted
      // line stored, we need to process them.
      for (const row of getModifiedRows(modifiedLines, showSideBySideDiff)) {
        rows.push(row)
      }
      modifiedLines = []
    }

    if (line.type === DiffLineType.Hunk) {
      rows.push({
        type: DiffRowType.Hunk,
        content: line.text,
        expansionType: enableDiffExpansion
          ? hunk.expansionType
          : DiffHunkExpansionType.None,
        hunkIndex,
      })
      continue
    }

    if (line.type === DiffLineType.Context) {
      assertNonNullable(
        line.oldLineNumber,
        `No oldLineNumber for ${diffLineNumber}`
      )
      assertNonNullable(
        line.newLineNumber,
        `No newLineNumber for ${diffLineNumber}`
      )

      rows.push({
        type: DiffRowType.Context,
        content: line.content,
        beforeLineNumber: line.oldLineNumber,
        afterLineNumber: line.newLineNumber,
        beforeTokens: [],
        afterTokens: [],
      })
      continue
    }

    assertNever(line.type, `Invalid line type: ${line.type}`)
  }

  // Do one more pass to process the remaining list of modified lines.
  if (modifiedLines.length > 0) {
    for (const row of getModifiedRows(modifiedLines, showSideBySideDiff)) {
      rows.push(row)
    }
  }

  return rows
}

function getModifiedRows(
  addedDeletedLines: ReadonlyArray<ModifiedLine>,
  showSideBySideDiff: boolean
): ReadonlyArray<SimplifiedDiffRow> {
  if (addedDeletedLines.length === 0) {
    return []
  }
  const hunkStartLine = addedDeletedLines[0].diffLineNumber
  const addedLines = new Array<ModifiedLine>()
  const deletedLines = new Array<ModifiedLine>()

  for (const line of addedDeletedLines) {
    if (line.line.type === DiffLineType.Add) {
      addedLines.push(line)
    } else if (line.line.type === DiffLineType.Delete) {
      deletedLines.push(line)
    }
  }

  const output = new Array<SimplifiedDiffRow>()

  const diffTokensBefore = new Array<ILineTokens | undefined>()
  const diffTokensAfter = new Array<ILineTokens | undefined>()

  // To match the behavior of github.com, we only highlight differences between
  // lines on hunks that have the same number of added and deleted lines.
  const shouldDisplayDiffInChunk = addedLines.length === deletedLines.length

  if (shouldDisplayDiffInChunk) {
    for (let i = 0; i < deletedLines.length; i++) {
      const addedLine = addedLines[i]
      const deletedLine = deletedLines[i]

      if (
        addedLine.line.content.length < MaxLineLengthToCalculateDiff &&
        deletedLine.line.content.length < MaxLineLengthToCalculateDiff
      ) {
        const { before, after } = getDiffTokens(
          deletedLine.line.content,
          addedLine.line.content
        )
        diffTokensBefore[i] = before
        diffTokensAfter[i] = after
      }
    }
  }

  let indexModifiedRow = 0

  while (
    showSideBySideDiff &&
    indexModifiedRow < addedLines.length &&
    indexModifiedRow < deletedLines.length
  ) {
    const addedLine = forceUnwrap(
      'Unexpected null line',
      addedLines[indexModifiedRow]
    )
    const deletedLine = forceUnwrap(
      'Unexpected null line',
      deletedLines[indexModifiedRow]
    )

    // Modified lines
    output.push({
      type: DiffRowType.Modified,
      beforeData: getDataFromLine(
        deletedLine,
        'oldLineNumber',
        diffTokensBefore.shift()
      ),
      afterData: getDataFromLine(
        addedLine,
        'newLineNumber',
        diffTokensAfter.shift()
      ),
      hunkStartLine,
    })

    indexModifiedRow++
  }

  for (let i = indexModifiedRow; i < deletedLines.length; i++) {
    const line = forceUnwrap('Unexpected null line', deletedLines[i])

    output.push({
      type: DiffRowType.Deleted,
      data: getDataFromLine(line, 'oldLineNumber', diffTokensBefore.shift()),
      hunkStartLine,
    })
  }

  for (let i = indexModifiedRow; i < addedLines.length; i++) {
    const line = forceUnwrap('Unexpected null line', addedLines[i])

    // Added line
    output.push({
      type: DiffRowType.Added,
      data: getDataFromLine(line, 'newLineNumber', diffTokensAfter.shift()),
      hunkStartLine,
    })
  }

  return output
}

function getDataFromLine(
  { line, diffLineNumber }: { line: DiffLine; diffLineNumber: number },
  lineToUse: 'oldLineNumber' | 'newLineNumber',
  diffTokens: ILineTokens | undefined
): SimplifiedDiffRowData {
  const lineNumber = forceUnwrap(
    `Expecting ${lineToUse} value for ${line}`,
    line[lineToUse]
  )

  const tokens = new Array<ILineTokens>()

  if (diffTokens !== undefined) {
    tokens.push(diffTokens)
  }

  return {
    content: line.content,
    lineNumber,
    diffLineNumber: line.originalLineNumber,
    noNewLineIndicator: line.noTrailingNewLine,
    tokens,
  }
}

/**
 * Helper class that lets us index search results both by their row
 * and column for fast lookup durig the render phase but also by their
 * relative order (index) allowing us to efficiently perform backwards search.
 */
class SearchResults {
  private readonly lookup = new Map<string, ILineTokens>()
  private readonly hits = new Array<[number, DiffColumn, number, number]>()

  private getKey(row: number, column: DiffColumn) {
    return `${row}.${column}`
  }

  public add(row: number, column: DiffColumn, offset: number, length: number) {
    const key = this.getKey(row, column)
    const existing = this.lookup.get(key)
    const token: IToken = { length, token: 'search-result' }

    if (existing !== undefined) {
      existing[offset] = token
    } else {
      this.lookup.set(key, { [offset]: token })
    }

    this.hits.push([row, column, offset, length])
  }

  public get length() {
    return this.hits.length
  }

  public get(index: number) {
    const hit = this.hits[index]
    return hit === undefined
      ? undefined
      : { row: hit[0], column: hit[1], offset: hit[2], length: hit[3] }
  }

  public getLineTokens(row: number, column: DiffColumn) {
    return this.lookup.get(this.getKey(row, column))
  }
}

function calcSearchTokens(
  diff: ITextDiff,
  showSideBySideDiffs: boolean,
  searchQuery: string,
  enableDiffExpansion: boolean
): SearchResults | undefined {
  if (searchQuery.length === 0) {
    return undefined
  }

  const hits = new SearchResults()
  const searchRe = new RegExp(escapeRegExp(searchQuery), 'gi')
  const rows = getDiffRows(diff, showSideBySideDiffs, enableDiffExpansion)

  for (const [rowNumber, row] of rows.entries()) {
    if (row.type === DiffRowType.Hunk) {
      continue
    }

    for (const column of enumerateColumnContents(row, showSideBySideDiffs)) {
      for (const match of column.content.matchAll(searchRe)) {
        if (match.index !== undefined) {
          hits.add(rowNumber, column.type, match.index, match[0].length)
        }
      }
    }
  }

  return hits
}

function* enumerateColumnContents(
  row: SimplifiedDiffRow,
  showSideBySideDiffs: boolean
): IterableIterator<{ type: DiffColumn; content: string }> {
  if (row.type === DiffRowType.Hunk) {
    yield { type: DiffColumn.Before, content: row.content }
  } else if (row.type === DiffRowType.Added) {
    const type = showSideBySideDiffs ? DiffColumn.After : DiffColumn.Before
    yield { type, content: row.data.content }
  } else if (row.type === DiffRowType.Deleted) {
    yield { type: DiffColumn.Before, content: row.data.content }
  } else if (row.type === DiffRowType.Context) {
    yield { type: DiffColumn.Before, content: row.content }
    if (showSideBySideDiffs) {
      yield { type: DiffColumn.After, content: row.content }
    }
  } else if (row.type === DiffRowType.Modified) {
    yield { type: DiffColumn.Before, content: row.beforeData.content }
    yield { type: DiffColumn.After, content: row.afterData.content }
  } else {
    assertNever(row, `Unknown row type ${row}`)
  }
}

function isInSelection(
  diffLineNumber: number,
  row: number,
  column: DiffColumn,
  selection: DiffSelection | undefined,
  temporarySelection: ISelection | undefined
) {
  const isInStoredSelection = selection?.isSelected(diffLineNumber) ?? false

  if (temporarySelection === undefined) {
    return isInStoredSelection
  }

  const isInTemporary = isInTemporarySelection(row, column, temporarySelection)

  if (temporarySelection.isSelected) {
    return isInStoredSelection || isInTemporary
  } else {
    return isInStoredSelection && !isInTemporary
  }
}

export function isInTemporarySelection(
  row: number,
  column: DiffColumn,
  selection: ISelection | undefined
): selection is ISelection {
  if (selection === undefined) {
    return false
  }

  if (
    row >= Math.min(selection.from.row, selection.to.row) &&
    row <= Math.max(selection.to.row, selection.from.row) &&
    (column === selection.from.column || column === selection.to.column)
  ) {
    return true
  }

  return false
}
