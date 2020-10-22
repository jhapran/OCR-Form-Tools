// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import _ from "lodash";
import React, { RefObject } from "react";
import { connect } from "react-redux";
import { RouteComponentProps } from "react-router-dom";
import SplitPane from "react-split-pane";
import { bindActionCreators } from "redux";
import { PrimaryButton } from "@fluentui/react";
import HtmlFileReader from "../../../../common/htmlFileReader";
import { strings, interpolate } from "../../../../common/strings";
import {
    AssetState, AssetType, EditorMode, FieldType,
    IApplicationState, IAppSettings, IAsset, IAssetMetadata,
    ILabel, IProject, IRegion, ISize, ITag, FeatureCategory, TagInputMode, FieldFormat, ITableTag, ITableRegion, AssetLabelingState
} from "../../../../models/applicationState";
import IApplicationActions, * as applicationActions from "../../../../redux/actions/applicationActions";
import IProjectActions, * as projectActions from "../../../../redux/actions/projectActions";
import IAppTitleActions, * as appTitleActions from "../../../../redux/actions/appTitleActions";
import { AssetPreview, ContentSource } from "../../common/assetPreview/assetPreview";
import { KeyboardBinding } from "../../common/keyboardBinding/keyboardBinding";
import { KeyEventType } from "../../common/keyboardManager/keyboardManager";
import { TagInput } from "../../common/tagInput/tagInput";
import { tagIndexKeys } from "../../common/tagInput/tagIndexKeys";
import Canvas from "./canvas";
import { TableView } from "./tableView"
import CanvasHelpers from "./canvasHelpers";
import "./editorPage.scss";
import EditorSideBar from "./editorSideBar";
import Alert from "../../common/alert/alert";
import Confirm from "../../common/confirm/confirm";
import { OCRService } from "../../../../services/ocrService";
import { throttle } from "../../../../common/utils";
import { constants } from "../../../../common/constants";
import PreventLeaving from "../../common/preventLeaving/preventLeaving";
import { Spinner, SpinnerSize } from "@fluentui/react/lib/Spinner";
import { getPrimaryBlueTheme, getPrimaryGreenTheme, getPrimaryRedTheme } from "../../../../common/themes";
import { toast } from "react-toastify";
import { PredictService } from "../../../../services/predictService";
import { AssetService } from "../../../../services/assetService";
import clone from "rfdc";
import { Tag } from "reactstrap";

/**
 * Properties for Editor Page
 * @member project - Project being edited
 * @member recentProjects - Array of projects recently viewed/edited
 * @member actions - Project actions
 * @member applicationActions - Application setting actions
 */
export interface IEditorPageProps extends RouteComponentProps, React.Props<EditorPage> {
    project: IProject;
    recentProjects: IProject[];
    appSettings: IAppSettings;
    actions: IProjectActions;
    applicationActions: IApplicationActions;
    appTitleActions: IAppTitleActions;
}

/**
 * State for Editor Page
 */
export interface IEditorPageState {
    /** Array of assets in project */
    assets: IAsset[];
    /** The editor mode to set for canvas tools */
    editorMode: EditorMode;
    /** The selected asset for the primary editing experience */
    selectedAsset?: IAssetMetadata;
    /** Currently selected region on current asset */
    selectedRegions?: IRegion[];
    /** Most recently selected tag */
    selectedTag: string;
    /** Tags locked for region labeling */
    lockedTags: string[];
    /** Size of the asset thumbnails to display in the side bar */
    thumbnailSize: ISize;
    /**
     * Whether or not the editor is in a valid state
     * State is invalid when a region has not been tagged
     */
    isValid: boolean;
    /** Whether the show invalid region warning alert should display */
    showInvalidRegionWarning: boolean;
    /** Show tags when loaded */
    tagsLoaded: boolean;
    /** The currently hovered TagInputItemLabel */
    hoveredLabel: ILabel;
    /** Whether the task for loading all OCRs is running */
    isRunningOCRs?: boolean;
    isRunningAutoLabeling?: boolean;
    /** Whether OCR is running in the main canvas */
    isCanvasRunningOCR?: boolean;
    isCanvasRunningAutoLabeling?: boolean;
    isError?: boolean;
    errorTitle?: string;
    errorMessage?: string;
    tableToView: object;
    tableToViewId: string;
    tagInputMode: TagInputMode;
    selectedTableTagToLabel: ITableTag;
    selectedTableTagBody: ITableRegion[][][];
    rightSplitPaneWidth?: number;
    reconfigureTableConfirm?: boolean;
    basicInputRightPaneWidth?: number;
}

function mapStateToProps(state: IApplicationState) {
    return {
        recentProjects: state.recentProjects,
        project: state.currentProject,
        appSettings: state.appSettings,
    };
}

function mapDispatchToProps(dispatch) {
    return {
        actions: bindActionCreators(projectActions, dispatch),
        applicationActions: bindActionCreators(applicationActions, dispatch),
        appTitleActions: bindActionCreators(appTitleActions, dispatch),
    };
}

/**
 * @name - Editor Page
 * @description - Page for adding/editing/removing tags to assets
 */
@connect(mapStateToProps, mapDispatchToProps)
export default class EditorPage extends React.Component<IEditorPageProps, IEditorPageState> {
    public state: IEditorPageState = {
        selectedTag: null,
        lockedTags: [],
        assets: [],
        editorMode: EditorMode.Select,
        thumbnailSize: { width: 175, height: 155 },
        isValid: true,
        showInvalidRegionWarning: false,
        tagsLoaded: false,
        hoveredLabel: null,
        tableToView: null,
        tableToViewId: null,
        tagInputMode: TagInputMode.Basic,
        selectedTableTagToLabel: null,
        selectedTableTagBody: [[]],
        rightSplitPaneWidth: 650,
        basicInputRightPaneWidth: null,
    };

    private tagInputRef: RefObject<TagInput>;

    private loadingProjectAssets: boolean = false;
    private canvas: RefObject<Canvas> = React.createRef();
    private renameTagConfirm: React.RefObject<Confirm> = React.createRef();
    private renameCanceled: () => void;
    private deleteTagConfirm: React.RefObject<Confirm> = React.createRef();
    private deleteDocumentConfirm: React.RefObject<Confirm> = React.createRef();
    private reconfigTableConfirm: React.RefObject<Confirm> = React.createRef();

    private isUnmount: boolean = false;

    constructor(props) {
        super(props);
        this.tagInputRef = React.createRef();
    }

    public async componentDidMount() {
        window.addEventListener("focus", this.onFocused);

        this.isUnmount = false;
        const projectId = this.props.match.params["projectId"];
        if (this.props.project) {
            await this.loadProjectAssets();
            this.props.appTitleActions.setTitle(this.props.project.name);
        } else if (projectId) {
            const project = this.props.recentProjects.find((project) => project.id === projectId);
            await this.props.actions.loadProject(project);
            this.props.appTitleActions.setTitle(project.name);
        }
        document.title = strings.editorPage.title + " - " + strings.appName;
    }

    public async componentDidUpdate(prevProps: Readonly<IEditorPageProps>) {
        if (this.props.project) {
            if (this.state.assets.length === 0) {
                await this.loadProjectAssets();
            } else {
                this.updateAssetsState();
            }
        }
    }

    public componentWillUnmount() {
        this.isUnmount = true;
        window.removeEventListener("focus", this.onFocused);
    }

    public render() {
        const { project } = this.props;
        const { assets, selectedAsset, isRunningOCRs, isCanvasRunningOCR, isCanvasRunningAutoLabeling } = this.state;

        const labels = (selectedAsset &&
            selectedAsset.labelData &&
            selectedAsset.labelData.labels) || [];

        const needRunOCRButton = assets.some((asset) => asset.state === AssetState.NotVisited);

        if (!project) {
            return (<div>Loading...</div>);
        }

        const isBasicInputMode = this.state.tagInputMode === TagInputMode.Basic;

        const size = isBasicInputMode ? 290 : 652;
        return (
            <div className="editor-page skipToMainContent" id="pageEditor">
                {this.state.tableToView !== null &&
                    <TableView
                        handleTableViewClose={this.handleTableViewClose}
                        tableToView={this.state.tableToView}
                    />
                }
                {
                    tagIndexKeys.map((index) =>
                        (<KeyboardBinding
                            displayName={strings.editorPage.tags.hotKey.apply}
                            key={index}
                            keyEventType={KeyEventType.KeyDown}
                            accelerators={[`${index}`]}
                            icon={"fa-tag"}
                            handler={this.handleTagHotKey} />))
                }
                <SplitPane
                    split="vertical"
                    defaultSize={this.state.thumbnailSize.width}
                    minSize={150}
                    maxSize={325}
                    paneStyle={{ display: "flex" }}
                    onChange={this.onSideBarResize}
                    onDragFinished={this.onSideBarResizeComplete}>
                    <div className="editor-page-sidebar bg-lighter-1">
                        {needRunOCRButton && <div>
                            <PrimaryButton
                                theme={getPrimaryGreenTheme()}
                                className="editor-page-sidebar-run-ocr"
                                type="button"
                                onClick={() => this.loadOcrForNotVisited()}
                                disabled={this.isBusy()}>
                                {this.state.isRunningOCRs ?
                                    <div>
                                        <Spinner
                                            size={SpinnerSize.small}
                                            label="Running OCR"
                                            ariaLive="off"
                                            labelPosition="right"
                                        />
                                    </div> : "Run OCR on unvisited documents"
                                }
                            </PrimaryButton>
                        </div>}
                        <EditorSideBar
                            assets={assets}
                            selectedAsset={selectedAsset ? selectedAsset.asset : null}
                            onBeforeAssetSelected={this.onBeforeAssetSelected}
                            onAssetSelected={this.selectAsset}
                            onAssetLoaded={this.onAssetLoaded}
                            thumbnailSize={this.state.thumbnailSize}
                        />

                    </div>
                    <div className="editor-page-content" onClick={this.onPageClick}>
                        <SplitPane split = "vertical"
                            primary = "second"
                            maxSize={isBasicInputMode ?
                                this.state.basicInputRightPaneWidth ? 400 : 290
                                : 900}
                            minSize={size}
                            className={"right-vertical_splitPane"}
                            defaultSize={this.state.basicInputRightPaneWidth ? this.state.basicInputRightPaneWidth : size}
                            pane1Style = {{height: "100%"}}
                            pane2Style = {{height: "auto"}}
                            resizerStyle={{
                                width: "5px",
                                margin: "0px",
                                border: "2px",
                                background: "transparent"
                            }}
                            onChange={(width) => {
                                this.resizeCanvas();
                                if (isBasicInputMode) {
                                    this.setState({basicInputRightPaneWidth: width})
                                } else {
                                    this.setState({ rightSplitPaneWidth: width });
                                }
                            }}>
                            <div className="editor-page-content-main" >
                                <div className="editor-page-content-main-body" onClick={this.onPageContainerClick}>
                                    {selectedAsset &&
                                        <Canvas
                                            ref={this.canvas}
                                            selectedAsset={this.state.selectedAsset}
                                            onAssetMetadataChanged={this.onAssetMetadataChanged}
                                            onCanvasRendered={this.onCanvasRendered}
                                            onSelectedRegionsChanged={this.onSelectedRegionsChanged}
                                            onRegionDoubleClick={this.onRegionDoubleClick}
                                            onRunningOCRStatusChanged={this.onCanvasRunningOCRStatusChanged}
                                            onRunningAutoLabelingStatusChanged={this.onCanvasRunningAutoLabelingStatusChanged}
                                            onTagChanged={this.onTagChanged}
                                            onAssetDeleted={this.confirmDocumentDeleted}
                                            editorMode={this.state.editorMode}
                                            project={this.props.project}
                                            lockedTags={this.state.lockedTags}
                                            hoveredLabel={this.state.hoveredLabel}
                                            setTableToView={this.setTableToView}
                                            closeTableView={this.closeTableView}
                                            runOcrForAllDocs={this.loadOcrForNotVisited}
                                            runAutoLabelingOnNextBatch={this.runAutoLabelingOnNextBatch}
                                            appSettings={this.props.appSettings}
                                            handleLabelTable={this.handleLabelTable}
                                        >
                                            <AssetPreview
                                                controlsEnabled={this.state.isValid}
                                                onBeforeAssetChanged={this.onBeforeAssetSelected}
                                                asset={this.state.selectedAsset.asset} />
                                        </Canvas>
                                    }
                                </div>
                            </div>
                            <div className="editor-page-right-sidebar">
                                <TagInput
                                    tagsLoaded={this.state.tagsLoaded}
                                    tags={this.props.project.tags}
                                    lockedTags={this.state.lockedTags}
                                    selectedRegions={this.state.selectedRegions}
                                    labels={labels}
                                    onChange={this.onTagsChanged}
                                    onLockedTagsChange={this.onLockedTagsChanged}
                                    onTagClick={this.onTagClicked}
                                    onCtrlTagClick={this.onCtrlTagClicked}
                                    onTagRename={this.confirmTagRename}
                                    onTagDeleted={this.confirmTagDeleted}
                                    onLabelEnter={this.onLabelEnter}
                                    onLabelLeave={this.onLabelLeave}
                                    onTagChanged={this.onTagChanged}
                                    ref = {this.tagInputRef}
                                    setTagInputMode={this.setTagInputMode}
                                    tagInputMode={this.state.tagInputMode}
                                    handleLabelTable={this.handleLabelTable}
                                    selectedTableTagToLabel={this.state.selectedTableTagToLabel}
                                    handleTableCellClick={this.handleTableCellClick}
                                    selectedTableTagBody={this.state.selectedTableTagBody}
                                    splitPaneWidth={this.state.rightSplitPaneWidth}
                                    reconfigureTableConfirm={this.reconfigureTableConfirm}
                                    addRowToDynamicTable={this.addRowToDynamicTable}
                                    onTagDoubleClick={this.onLabelDoubleClicked}
                                    />
                                <Confirm
                                    title={strings.editorPage.tags.rename.title}
                                    ref={this.renameTagConfirm}
                                    message={strings.editorPage.tags.rename.confirmation}
                                    confirmButtonTheme={getPrimaryRedTheme()}
                                    onCancel={this.onTagRenameCanceled}
                                    onConfirm={this.onTagRenamed}
                                />
                                <Confirm
                                    title={strings.editorPage.tags.delete.title}
                                    ref={this.deleteTagConfirm}
                                    message={strings.editorPage.tags.delete.confirmation}
                                    confirmButtonTheme={getPrimaryRedTheme()}
                                    onConfirm={this.onTagDeleted}
                                />
                                {this.state.selectedAsset &&
                                    <Confirm
                                        title={strings.editorPage.asset.delete.title}
                                        ref={this.deleteDocumentConfirm}
                                        message={
                                            strings.editorPage.asset.delete.confirmation +
                                            "\"" + this.state.selectedAsset.asset.name + "\"?"
                                        }
                                        confirmButtonTheme={getPrimaryRedTheme()}
                                        onConfirm={this.onAssetDeleted}
                                    />
                                }
                                    <Confirm
                                        title={strings.tags.regionTableTags.confirm.reconfigure.title}
                                        ref={this.reconfigTableConfirm}
                                        message={strings.tags.regionTableTags.confirm.reconfigure.message}
                                        confirmButtonTheme={getPrimaryBlueTheme()}
                                        onConfirm={()=> {this.setState({tagInputMode: TagInputMode.LabelTable}, () => this.resizeCanvas()); this.resizeCanvas(); }}
                                    />

                            </div>
                        </SplitPane>
                    </div>
                </SplitPane>
                <Alert
                    show={this.state.showInvalidRegionWarning}
                    title={strings.editorPage.messages.enforceTaggedRegions.title}
                    // tslint:disable-next-line:max-line-length
                    message={strings.editorPage.messages.enforceTaggedRegions.description}
                    onClose={() => this.setState({ showInvalidRegionWarning: false })}
                />
                <Alert
                    show={this.state.isError}
                    title={this.state.errorTitle || "Error"}
                    message={this.state.errorMessage}
                    onClose={() => this.setState({
                        isError: false,
                        errorTitle: undefined,
                        errorMessage: undefined,
                    })}
                />
                <PreventLeaving
                    when={isRunningOCRs || isCanvasRunningOCR}
                    message={"An OCR operation is currently in progress, are you sure you want to leave?"}
                />
                <PreventLeaving
                    when={isCanvasRunningAutoLabeling}
                    message={"An AutoLabeling option is currently in progress, are you sure you want to leave?"} />
            </div>
        );
    }

    // call function from child
    private onPageContainerClick = () => {
        // workaround: tagInput will not lost focus with olmap,
        // so we fire the blur event manually here
        this.tagInputRef.current.triggerNewTagBlur();
    }

    // tslint:disable-next-line:no-empty
    private onPageClick = () => {
    }

    private setTagInputMode = (tagInputMode: TagInputMode, selectedTableTagToLabel: ITableTag = this.state.selectedTableTagToLabel, selectedTableTagBody: ITableRegion[][][] = this.state.selectedTableTagBody) => {
        // this.resizeCanvas();

            this.setState({
                selectedTableTagBody,
                selectedTableTagToLabel,
                tagInputMode,
            }, () => {
                this.resizeCanvas();
                console.log("EditorPage -> privatesetTagInputMode -> resizeCanvas")
            });

    }

    private handleLabelTable = (tagInputMode: TagInputMode = this.state.tagInputMode, selectedTableTagToLabel: ITableTag = this.state.selectedTableTagToLabel) => {
        console.log(tagInputMode);
        console.log(selectedTableTagToLabel)
        if (selectedTableTagToLabel == null) {
            return;
        }
        const selectedTableTagBody = new Array(selectedTableTagToLabel.rowKeys?.length || 1);
        if (this.state.selectedTableTagToLabel?.name === selectedTableTagToLabel?.name && selectedTableTagToLabel.format === FieldFormat.RowDynamic) {
            for (let i = 1; i < this.state.selectedTableTagBody.length; i++) {
                selectedTableTagBody.push(undefined)
            }
        }
        for (let i = 0; i < selectedTableTagBody.length; i++) {
            selectedTableTagBody[i] = new Array(selectedTableTagToLabel.columnKeys.length);
        }
        const tagAssets = clone()(this.state.selectedAsset.regions).filter((region) => region.tags[0] === selectedTableTagToLabel.name) as ITableRegion[];
        tagAssets.forEach((region => {
            let rowIndex: number;
            if (selectedTableTagToLabel.format === FieldFormat.RowDynamic) {
                rowIndex = Number(region.rowKey.slice(1)) - 1;
            } else {
                rowIndex = selectedTableTagToLabel.rowKeys.findIndex(rowKey => rowKey.fieldKey === region.rowKey)
            }
            for (let i = selectedTableTagBody.length; i <= rowIndex; i++){
                selectedTableTagBody.push(new Array(selectedTableTagToLabel.columnKeys.length));
            }
            const colIndex = selectedTableTagToLabel.columnKeys.findIndex(colKey => colKey.fieldKey === region.columnKey)
            if (selectedTableTagBody[rowIndex][colIndex] != null) {
                selectedTableTagBody[rowIndex][colIndex].push(region)
            } else {
                selectedTableTagBody[rowIndex][colIndex] = [region]
            }        }))
        this.setState({
            selectedTableTagToLabel,
            selectedTableTagBody,
        }, () => {
            this.setTagInputMode(tagInputMode);
        });

    }
    private addRowToDynamicTable = () => {
        const selectedTableTagBody = clone()(this.state.selectedTableTagBody)
        selectedTableTagBody.push(Array(this.state.selectedTableTagToLabel.columnKeys.length));
        this.setState({selectedTableTagBody});
    }

    private handleTableCellClick = (rowIndex: number, columnIndex: number) => {
        // const inputTag = this.state.selectedTableTagToLabel as ITableTag;
        // console.log("EditorPage -> privatehandleTableCellClick -> this.props.project.tags", this.props.project.tags)
        // console.log("EditorPage -> privatehandleTableCellClick -> this.state.selectedTag", this.state.selectedTag)
        // console.log(inputTag, rowIndex, columnIndex);
        // if (inputTag.rowKeys[rowIndex].fieldType === FieldType.SelectionMark || inputTag.columnKeys[columnIndex].fieldType === FieldType.SelectionMark) {
        //     toast.warn("selection mark support for semantic tables is still a work in progress");
        //     return;
        // }
        // const selectedTableTagBody = clone()(this.state.selectedTableTagBody);
        // if (selectedTableTagBody[rowIndex][columnIndex] != null) {
        //     selectedTableTagBody[rowIndex][columnIndex].concat(clone()(this.state.selectedRegions));
        // } else {
        //     selectedTableTagBody[rowIndex][columnIndex] = clone()(this.state.selectedRegions);
        // }
        // console.log("EditorPage -> privatehandleTableCellClick -> selectedTableTagBody", selectedTableTagBody)
        this.onTableTagClicked(this.state.selectedTableTagToLabel, rowIndex, columnIndex);
    }

    // private resetTableBody = () => {
    //     const selectedTableTagToLabel = this.state.selectedTableTagToLabel as ITableTag;
    //     const selectedTableTagBody = new Array(selectedTableTagToLabel.rowKeys.length);
    //     const tagAssets = this.state.selectedAsset.regions.filter((region) => region.tags[0] === selectedTableTagToLabel.name) as ITableRegion[];
    //     console.log("EditorPage -> privatehandleLabelTable -> tagAssets", tagAssets)
    //     for (let i = 0; i < selectedTableTagBody.length; i++) {
    //         selectedTableTagBody[i] = new Array(selectedTableTagToLabel.columnKeys.length);
    //     }
    //     tagAssets.forEach((region => {
    //         const rowIndex = selectedTableTagToLabel.rowKeys.findIndex(rowKey => rowKey.fieldKey === region.rowKey)
    //         const colIndex = selectedTableTagToLabel.columnKeys.findIndex(colKey => colKey.fieldKey === region.columnKey)
    //         if (selectedTableTagBody[rowIndex][colIndex]) {
    //             selectedTableTagBody[rowIndex][colIndex] += " " + region.value
    //         } else {
    //             selectedTableTagBody[rowIndex][colIndex] = region.value

    //         }
    //     }))
    //     console.log("EditorPage -> privatehandleLabelTable -> selectedTableTagBody", selectedTableTagBody)
    //     this.setState({
    //         selectedTableTagBody,
    //     })
    // }

    /**
     * Called when the asset side bar is resized
     * @param newWidth The new sidebar width
     */
    private onSideBarResize = (newWidth: number) => {
        this.setState({
            thumbnailSize: {
                width: newWidth,
                height: newWidth / (4 / 3),
            },
        });
        this.resizeCanvas()
        if (this.state.tagInputMode === TagInputMode.Basic) {
            this.setState({basicInputRightPaneWidth: newWidth})
        }
    }

    /**
     * Called when the asset sidebar has been completed
     */
    private onSideBarResizeComplete = () => {
        const appSettings = {
            ...this.props.appSettings,
            thumbnailSize: this.state.thumbnailSize,
        };

        this.props.applicationActions.saveAppSettings(appSettings);
    }

    /**
     * Called when a tag from footer is clicked
     * @param tag Tag clicked
     */
    private onTagClicked = (tag: ITag): void => {
        this.setState({
            selectedTag: tag.name,
            lockedTags: [],
        }, () => this.canvas.current.applyTag(tag.name));
    }

    private onTableTagClicked = (tag: ITag, rowIndex: number, columnIndex: number): void => {
        if (tag.format === FieldFormat.RowDynamic) {

        }
        this.setState({
            selectedTag: tag.name,
            lockedTags: [],
        }, () => this.canvas.current.applyTag(tag.name, rowIndex, columnIndex));
    }

    /**
     * Open confirm dialog for tag renaming
     */
    private confirmTagRename = (tag: ITag, newTag: ITag, cancelCallback: () => void): void => {
        this.renameCanceled = cancelCallback;
        this.renameTagConfirm.current.open(tag, newTag);
    }

    /**
     * Renames tag in assets and project, and saves files
     * @param tag Tag to be renamed
     * @param newTag Tag with the new name
     */
    private onTagRenamed = async (tag: ITag, newTag: ITag): Promise<void> => {
        this.renameCanceled = null;
        const assetUpdates = await this.props.actions.updateProjectTag(this.props.project, tag, newTag);
        const selectedAsset = assetUpdates.find((am) => am.asset.id === this.state.selectedAsset.asset.id);

        if (selectedAsset) {
            if (selectedAsset) {
                this.setState({ selectedAsset });
            }
        }
    }

    private onTagRenameCanceled = () => {
        if (this.renameCanceled) {
            this.renameCanceled();
            this.renameCanceled = null;
        }
    }

    /**
     * Open Confirm dialog for tag deletion
     */
    private confirmTagDeleted = (tagName: string): void => {
        this.deleteTagConfirm.current.open(tagName);
    }

    /**
     * Open Confirm dialog for document deletion
     */
    private confirmDocumentDeleted = (): void => {
        this.deleteDocumentConfirm.current.open();
    }

    /**
     * Removes tag from assets and projects and saves files
     * @param tagName Name of tag to be deleted
     */
    private onTagDeleted = async (tagName: string): Promise<void> => {
        const assetUpdates = await this.props.actions.deleteProjectTag(this.props.project, tagName);

        const selectedAsset = assetUpdates.find((am) => am.asset.id === this.state.selectedAsset.asset.id);
        if (selectedAsset) {
            this.setState({ selectedAsset });
        }
    }

    private onCtrlTagClicked = (tag: ITag): void => {
        const locked = this.state.lockedTags;
        this.setState({
            selectedTag: tag.name,
            lockedTags: CanvasHelpers.toggleTag(locked, tag.name),
        }, () => this.canvas.current.applyTag(tag.name));
    }

    private getTagFromKeyboardEvent = (event: KeyboardEvent): ITag => {
        const index = tagIndexKeys.indexOf(event.key);
        const tags = this.props.project.tags;
        if (index >= 0 && index < tags.length) {
            return tags[index];
        }
        return null;
    }

    /**
     * Listens for {number key} and calls `onTagClicked` with tag corresponding to that number
     * @param event KeyDown event
     */
    private handleTagHotKey = (event: KeyboardEvent): void => {
        const tag = this.getTagFromKeyboardEvent(event);
        const selection = this.canvas.current.getSelectedRegions();

        if (tag && selection.length) {
            const { format, type, documentCount, name } = tag;
            const tagCategory = this.tagInputRef.current.getTagCategory(tag.type);
            const category = selection[0].category;
            const labels = this.state.selectedAsset.labelData.labels;
            const isTagLabelTypeDrawnRegion = this.tagInputRef.current.labelAssignedDrawnRegion(labels, tag.name);
            const labelAssigned = this.tagInputRef.current.labelAssigned(labels, name);

            if (labelAssigned && ((category === FeatureCategory.DrawnRegion) !== isTagLabelTypeDrawnRegion)) {
                if (isTagLabelTypeDrawnRegion) {
                    toast.warn(interpolate(strings.tags.warnings.notCompatibleWithDrawnRegionTag, { otherCategory: category }));
                } else if (tagCategory === FeatureCategory.Checkbox) {
                    toast.warn(interpolate(strings.tags.warnings.notCompatibleWithDrawnRegionTag, { otherCategory: FeatureCategory.Checkbox }));
                } else {
                    toast.warn(interpolate(strings.tags.warnings.notCompatibleWithDrawnRegionTag, { otherCategory: FeatureCategory.Text }));
                }
                return;
            } else if (tagCategory === category || category === FeatureCategory.DrawnRegion ||
                (documentCount === 0 && type === FieldType.String && format === FieldFormat.NotSpecified)) {
                if (tagCategory === FeatureCategory.Checkbox && labelAssigned) {
                    toast.warn(strings.tags.warnings.checkboxPerTagLimit);
                    return;
                }
                this.onTagClicked(tag);
            } else {
                toast.warn(strings.tags.warnings.notCompatibleTagType, { autoClose: 7000 });
            }
        }
        // do nothing if region was not selected
    }

    /**
     * Returns a value indicating whether the current asset is taggable
     */
    private isTaggableAssetType = (asset: IAsset): boolean => {
        return asset.type !== AssetType.Unknown;
    }

    /**
     * Raised when the selected asset has been changed.
     * This can either be a parent or child asset
     */
    private onAssetMetadataChanged = async (assetMetadata: IAssetMetadata): Promise<void> => {
        console.log("EditorPage -> assetMetadata", assetMetadata)
        // Comment out below code as we allow regions without tags, it would make labeler's work easier.
        assetMetadata = JSON.parse(JSON.stringify(assetMetadata)); // alex
        const initialState = assetMetadata.asset.state;

        const asset = { ...assetMetadata.asset };

        // console.log("EditorPage -> asset", asset)
        if (this.isTaggableAssetType(asset)) {
            const hasLabels = _.get(assetMetadata, "labelData.labels.length", 0) > 0;
            const hasTableLabels = _.get(assetMetadata, "labelData.tableLabels.length", 0) > 0;
            asset.state = hasLabels || hasTableLabels ?
                AssetState.Tagged :
                AssetState.Visited;
        } else if (asset.state === AssetState.NotVisited) {
            asset.state = AssetState.Visited;
        }

        // Only update asset metadata if state changes or is different
        if (initialState !== asset.state || this.state.selectedAsset !== assetMetadata) {
            if (this.state.selectedAsset?.labelData?.labels && assetMetadata?.labelData?.labels && assetMetadata.labelData.labels.toString() !== this.state.selectedAsset.labelData.labels.toString()) {
                await this.updatedAssetMetadata(assetMetadata);
            }
            assetMetadata.asset = asset;
            await this.props.actions.saveAssetMetadata(this.props.project, assetMetadata);
            if (this.props.project.lastVisitedAssetId === asset.id) {
                this.setState({ selectedAsset: assetMetadata });
            }
        }

        // Find and update the root asset in the internal state
        // This forces the root assets that are displayed in the sidebar to
        // accurately show their correct state (not-visited, visited or tagged)
        const assets = [...this.state.assets];
        // const asset = { ...assetMetadata.asset };
        const assetIndex = assets.findIndex((a) => a.id === asset.id);
        if (assetIndex > -1) {
            assets[assetIndex] = {
                ...asset,
            };
        }

        this.setState({ assets, isValid: true }, () => {
            this.handleLabelTable();
        });

        // Workaround for if component is unmounted
        if (!this.isUnmount) {
            this.props.appTitleActions.setTitle(`${this.props.project.name} - [ ${asset.name} ]`);
        }
    }

    private onAssetLoaded = (asset: IAsset, contentSource: ContentSource) => {
        const assets = [...this.state.assets];
        const assetIndex = assets.findIndex((item) => item.id === asset.id);
        if (assetIndex > -1) {
            const assets = [...this.state.assets];
            const item = { ...assets[assetIndex] };
            item.cachedImage = (contentSource as HTMLImageElement).src;
            assets[assetIndex] = item;
            this.setState({ assets });
        }
    }

    /**
     * Raised when the asset binary has been painted onto the canvas tools rendering canvas
     */
    private onCanvasRendered = async (canvas: HTMLCanvasElement) => {
        // When active learning auto-detect is enabled
        // run predictions when asset changes
    }

    private onSelectedRegionsChanged = (selectedRegions: IRegion[]) => {
        this.setState({ selectedRegions });
    }

    private onRegionDoubleClick = (region: IRegion) => {
        if (region.tags?.length > 0) {
            this.tagInputRef.current.focusTag(region.tags[0]);
        }
    }

    private onTagsChanged = async (tags) => {
        const project = {
            ...this.props.project,
            tags,
        };
        await this.props.actions.saveProject(project, true, false);
    }

    private onLockedTagsChanged = (lockedTags: string[]) => {
        this.setState({ lockedTags });
    }

    private onBeforeAssetSelected = (): boolean => {
        if (!this.state.isValid) {
            this.setState({ showInvalidRegionWarning: true });
        }

        return this.state.isValid;
    }

    private selectAsset = async (asset: IAsset): Promise<void> => {
        // Nothing to do if we are already on the same asset.
        if (this.state.selectedAsset && this.state.selectedAsset.asset.id === asset.id) {
            return;
        }

        if (!this.state.isValid) {
            this.setState({ showInvalidRegionWarning: true });
            return;
        }
        if (this.state.isCanvasRunningAutoLabeling) {
            return;
        }
        if (this.state.isRunningAutoLabeling) {
            return;
        }

        const assetMetadata = await this.props.actions.loadAssetMetadata(this.props.project, asset);

        try {
            if (!assetMetadata.asset.size) {
                const assetProps = await HtmlFileReader.readAssetAttributes(asset);
                assetMetadata.asset.size = { width: assetProps.width, height: assetProps.height };
            }
        } catch (err) {
            console.warn("Error computing asset size");
        }

        this.setState({
            tableToView: null,
            tableToViewId: null,
            selectedAsset: assetMetadata,
        }, async () => {
            await this.onAssetMetadataChanged(assetMetadata);
            await this.props.actions.saveProject(this.props.project, false, false);
        });
    }

    private reconfigureTableConfirm = () => {
        this.setState({reconfigureTableConfirm: true})
        this.reconfigTableConfirm.current.open();

    }

    private loadProjectAssets = async (): Promise<void> => {
        if (this.loadingProjectAssets) {
            return;
        }

        this.loadingProjectAssets = true;

        try {
            const assets = _(await this.props.actions.loadAssets(this.props.project))
                .uniqBy((asset) => asset.id)
                .value();
            if (this.state.assets.length === assets.length
                && JSON.stringify(this.state.assets) === JSON.stringify(assets)) {
                this.loadingProjectAssets = false;
                this.setState({ tagsLoaded: true });
                return;
            }

            const lastVisited = assets.find((asset) => asset.id === this.props.project.lastVisitedAssetId);

            this.setState({
                assets,
            }, async () => {
                await this.props.actions.saveProject(this.props.project, false, true);
                this.setState({ tagsLoaded: true });
                if (assets.length > 0) {
                    await this.selectAsset(lastVisited ? lastVisited : assets[0]);
                }
                this.loadingProjectAssets = false;
            });
        } catch (error) {
            throw Error(error);
        }
    }
    private isBusy = (): boolean => {
        return this.state.isRunningOCRs || this.state.isCanvasRunningOCR || this.state.isCanvasRunningAutoLabeling;
    }

    public loadOcrForNotVisited = async (runForAll?: boolean) => {
        if (this.isBusy()) {
            return;
        }
        const { project } = this.props;
        const ocrService = new OCRService(project);
        if (this.state.assets) {
            this.setState({ isRunningOCRs: true });
            try {
                await throttle(
                    constants.maxConcurrentServiceRequests,
                    this.state.assets
                        .filter((asset) => runForAll ? asset : asset.state === AssetState.NotVisited)
                        .map((asset) => asset.id),
                    async (assetId) => {
                        // Get the latest version of asset.
                        const asset = this.state.assets.find((asset) => asset.id === assetId);
                        if (asset && (asset.state === AssetState.NotVisited || runForAll)) {
                            try {
                                this.updateAssetState({ id: asset.id, isRunningOCR: true });
                                await ocrService.getRecognizedText(asset.path, asset.name, asset.mimeType, undefined, runForAll);
                                this.updateAssetState({ id: asset.id, isRunningOCR: false, assetState: AssetState.Visited });
                            } catch (err) {
                                this.updateAssetState({ id: asset.id, isRunningOCR: false });
                                this.setState({
                                    isError: true,
                                    errorTitle: err.title,
                                    errorMessage: err.message,
                                });
                            }
                        }
                    }
                );
            } finally {
                this.setState({ isRunningOCRs: false });
            }
        }
    }
    private runAutoLabelingOnNextBatch = async () => {
        if (this.isBusy()) {
            return;
        }
        const { project } = this.props;
        const predictService = new PredictService(project);
        const assetService = new AssetService(project);

        if (this.state.assets) {
            this.setState({ isRunningAutoLabeling: true });
            const unlabeledAssetsBatch = [];
            for (let i = 0; i < this.state.assets.length && unlabeledAssetsBatch.length < constants.autoLabelBatchSize; i++) {
                const asset = this.state.assets[i];
                if (asset.state === AssetState.NotVisited || asset.state === AssetState.Visited) {
                    unlabeledAssetsBatch.push(asset);
                }
            }
            try {
                await throttle(constants.maxConcurrentServiceRequests,
                    unlabeledAssetsBatch,
                    async (asset) => {
                        try {
                            this.updateAssetState({ id: asset.id, isRunningAutoLabeling: true });
                            const predictResult = await predictService.getPrediction(asset.path);
                            const assetMetadata = await assetService.getAssetPredictMetadata(asset, predictResult);
                            await assetService.uploadPredictResultAsOrcResult(asset, predictResult);
                            this.onAssetMetadataChanged(assetMetadata);
                            this.updateAssetState({
                                id: asset.id, isRunningAutoLabeling: false,
                                assetState: AssetState.Tagged,
                                labelingState: AssetLabelingState.AutoLabeled,
                            });
                            this.props.actions.updatedAssetMetadata(this.props.project, assetMetadata);
                        } catch (err) {
                            this.updateAssetState({ id: asset.id, isRunningOCR: false, isRunningAutoLabeling: false });
                            this.setState({
                                isError: true,
                                errorTitle: err.title,
                                errorMessage: err.message
                            })
                        }
                    }
                );

            } finally {
                this.setState({ isRunningAutoLabeling: false });
            }
        }
    }

    private updateAssetState = (newState: {
        id: string,
        isRunningOCR?: boolean,
        isRunningAutoLabeling?: boolean,
        assetState?: AssetState,
        labelingState?: AssetLabelingState
    }) => {
        this.setState((state) => ({
            assets: state.assets.map((asset) => {
                if (asset.id === newState.id) {
                    const updatedAsset = { ...asset, isRunningOCR: newState.isRunningOCR || false };
                    if (newState.assetState !== undefined && asset.state === AssetState.NotVisited) {
                        updatedAsset.state = newState.assetState;
                    }
                    if (newState.labelingState) {
                        updatedAsset.labelingState = newState.labelingState;
                    }
                    if (newState.isRunningAutoLabeling !== undefined) {
                        updatedAsset.isRunningAutoLabeling = newState.isRunningAutoLabeling;
                    }
                    return updatedAsset;
                } else {
                    return asset;
                }
            }),
        }), () => {
            const asset = this.state.assets.find((asset) => asset.id === newState.id);
            if (this.state.selectedAsset && newState.id === this.state.selectedAsset.asset.id) {
                if (asset) {
                    this.setState({
                        selectedAsset: { ...this.state.selectedAsset, asset: { ...asset } },
                    });
                }
            }
        });
    }

    /**
     * Updates the root asset list from the project assets
     */
    private updateAssetsState = () => {
        const updatedAssets = [...this.state.assets];
        let needUpdate = false;
        updatedAssets.forEach((asset) => {
            const projectAsset = _.get(this.props, `project.assets[${asset.id}]`, null);
            if (projectAsset) {
                if (asset.state !== projectAsset.state || asset.labelingState !== projectAsset.labelingState) {
                    needUpdate = true;
                    asset.state = projectAsset.state;
                    asset.labelingState = projectAsset.labelingState;
                }
            }
        });

        if (needUpdate) {
            this.setState({ assets: updatedAssets });
            if (this.state.selectedAsset) {
                const asset = this.state.selectedAsset.asset;
                const currentAsset = _.get(this.props, `project.assets[${this.state.selectedAsset.asset.id}]`, null);
                if (asset.state !== currentAsset.state || asset.labelingState !== currentAsset.labelingState) {
                    this.updateSelectAsset(asset);
                }
            }
        }
    }

    private updateSelectAsset = async (asset: IAsset) => {
        const assetMetadata = await this.props.actions.loadAssetMetadata(this.props.project, asset);

        try {
            if (!assetMetadata.asset.size) {
                const assetProps = await HtmlFileReader.readAssetAttributes(asset);
                assetMetadata.asset.size = { width: assetProps.width, height: assetProps.height };
            }
        } catch (err) {
            console.warn("Error computing asset size");
        }
        this.setState({
            tableToView: null,
            tableToViewId: null,
            selectedAsset: assetMetadata,
        }, async () => {
            await this.onAssetMetadataChanged(assetMetadata);
            await this.props.actions.saveProject(this.props.project, false, false);
        });
    }
    private onLabelEnter = (label: ILabel) => {
        this.setState({ hoveredLabel: label });
    }

    private onLabelDoubleClicked = (label:ILabel) =>{
        this.canvas.current.focusOnLabel(label);
    }

    private onLabelLeave = (label: ILabel) => {
        this.setState({ hoveredLabel: null });
    }

    private onCanvasRunningOCRStatusChanged = (isCanvasRunningOCR: boolean) => {
        this.setState({ isCanvasRunningOCR });
    }
    private onCanvasRunningAutoLabelingStatusChanged = (isCanvasRunningAutoLabeling: boolean) => {
        this.setState({ isCanvasRunningAutoLabeling });
    }
    private onFocused = () => {
        this.loadProjectAssets();
    }

    private onAssetDeleted = () => {
        this.props.actions.deleteAsset(this.props.project, this.state.selectedAsset).then(() => {
            this.loadProjectAssets();
        });
    }

    private onTagChanged = async (oldTag: ITag, newTag: ITag) => {
        const assetUpdates = await this.props.actions.updateProjectTag(this.props.project, oldTag, newTag);
        const selectedAsset = assetUpdates.find((am) => am.asset.id === this.state.selectedAsset.asset.id);

        if (selectedAsset) {
            this.setState({
                selectedAsset,
            });
        }
    }

    private setTableToView = async (tableToView, tableToViewId) => {
        if (this.state.tableToViewId) {
            this.canvas.current.setTableState(this.state.tableToViewId, "rest");
        }
        this.canvas.current.setTableState(tableToViewId, "selected");
        this.setState({
            tableToView,
            tableToViewId,
        });
    }

    private handleTableViewClose = () => {
        this.closeTableView("rest");
    }

    private closeTableView = (state: string) => {
        if (this.state.tableToView) {
            this.canvas.current.setTableState(this.state.tableToViewId, state);
            this.setState({
                tableToView: null,
                tableToViewId: null,
            });
        }
    }

    private resizeCanvas = () => {
        if (this.canvas.current) {
            this.canvas.current.updateSize();
        }
    }

    private async updatedAssetMetadata(assetMetadata: IAssetMetadata) {
        const assetDocumentCountDifference = {};
        const updatedAssetLabels = {};
        const currentAssetLabels = {};
        assetMetadata.labelData.labels.forEach((label) => {
            updatedAssetLabels[label.label] = true;
        });
        this.state.selectedAsset.labelData.labels.forEach((label) => {
            currentAssetLabels[label.label] = true;
        });
        Object.keys(currentAssetLabels).forEach((label) => {
            if (!updatedAssetLabels[label]) {
                assetDocumentCountDifference[label] = -1;
            }
        });
        Object.keys(updatedAssetLabels).forEach((label) => {
            if (!currentAssetLabels[label]) {
                assetDocumentCountDifference[label] = 1;
            }
        });
        await this.props.actions.updatedAssetMetadata(this.props.project, assetDocumentCountDifference);
    }
}
