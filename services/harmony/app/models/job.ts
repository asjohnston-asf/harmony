import _, { pick } from 'lodash';
import { ILengthAwarePagination } from 'knex-paginate'; // For types only
import { createMachine } from 'xstate';
import { CmrPermission, CmrPermissionsMap, getCollectionsByIds, getPermissions, CmrTagKeys } from '../util/cmr';
import { removeEmptyProperties } from '../util/object';
import { ConflictError } from '../util/errors';
import { createPublicPermalink } from '../frontends/service-results';
import { truncateString } from '@harmony/util/string';
import DBRecord from './record';
import { Transaction } from '../util/db';
import JobLink, { getLinksForJob, JobLinkOrRecord } from './job-link';
import WorkflowStep, { getWorkflowStepsByJobId } from './workflow-steps';

// how long data generated by this job will be available
export const EXPIRATION_DAYS = 30;

export const TEXT_LIMIT = 4096; // this.request and this.message need to be under the 4,096 char limit

import env from '../util/env';
import JobError from './job-error';
import { setReadyCountToZero } from './user-work';
import { Knex } from 'knex';
import { Logger } from 'winston';
import { LABELS_TABLE, JOBS_LABELS_TABLE, getLabelsForJob, setLabelsForJob } from './label';
const { awsDefaultRegion } = env;

// Lazily load the list of unique provider ids, once, when requested
let providerIdsSnapshot: string[];

export const jobRecordFields = [
  'username', 'status', 'message', 'progress', 'createdAt', 'updatedAt', 'request',
  'numInputGranules', 'jobID', 'requestId', 'batchesCompleted', 'isAsync', 'ignoreErrors', 'destination_url',
  'service_name', 'provider_id',
];

const stagingBucketTitle = `Results in AWS S3. Access from AWS ${awsDefaultRegion} with keys from /cloud-access.sh`;

export enum JobStatus {
  ACCEPTED = 'accepted',
  RUNNING = 'running',
  RUNNING_WITH_ERRORS = 'running_with_errors',
  SUCCESSFUL = 'successful',
  FAILED = 'failed',
  CANCELED = 'canceled',
  PAUSED = 'paused',
  PREVIEWING = 'previewing',
  COMPLETE_WITH_ERRORS = 'complete_with_errors',
}

export enum JobEvent {
  CANCEL = 'CANCEL',
  COMPLETE = 'COMPLETE',
  COMPLETE_WITH_ERRORS = 'COMPLETE_WITH_ERRORS',
  FAIL = 'FAIL',
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  SKIP_PREVIEW = 'SKIP_PREVIEW',
  START = 'START',
  START_WITH_PREVIEW = 'START_WITH_PREVIEW',

}
export interface JobRecord {
  id?: number;
  jobID: string;
  username: string;
  requestId: string;
  status?: JobStatus;
  message?: string;
  progress?: number;
  batchesCompleted?: number;
  links?: JobLinkOrRecord[];
  errors?: JobError[];
  request: string;
  isAsync?: boolean;
  ignoreErrors?: boolean;
  createdAt?: Date | number;
  updatedAt?: Date | number;
  numInputGranules: number;
  collectionIds: string[];
  provider_id?: string;
  destination_url?: string;
  service_name?: string,
}

/**
 * The format of a Job when returned to an end user.
 */
export class JobForDisplay {
  jobID: string;

  username: string;

  status: JobStatus;

  message: string;

  progress: number;

  createdAt: Date;

  updatedAt: Date;

  dataExpiration?: Date;

  links: JobLink[];

  labels: string[];

  request: string;

  numInputGranules: number;

  errors?: JobError[];

}

export interface JobQuery {
  where?: {
    id?: number;
    jobID?: string;
    username?: string;
    requestId?: string;
    status?: string;
    message?: string;
    progress?: number;
    batchesCompleted?: number;
    request?: string;
    isAsync?: boolean;
    ignoreErrors?: boolean;
  };
  dates?: {
    from?: Date;
    to?: Date;
    field: 'jobs.createdAt' | 'jobs.updatedAt';
  }
  whereIn?: {
    status?: { in: boolean, values: string[] };
    service_name?: { in: boolean, values: string[] };
    provider_id?: { in: boolean, values: string[] };
    username?: { in: boolean, values: string[] };
    jobID?: { in: boolean, values: string[] };
  }
  orderBy?: {
    field: string;
    value: string;
  }
}

// State machine definition for jobs. This is not used to maintain state, just to enforce
// transition rules
const stateMachine = createMachine(
  {
    id: 'job',
    initial: 'accepted',
    strict: true,
    predictableActionArguments: true,
    states: {
      accepted: {
        id: JobStatus.ACCEPTED,
        meta: {
          defaultMessage: 'The job has been accepted and is waiting to be processed',
          active: true,
        },
        on: Object.fromEntries([
          [JobEvent.START, { target: JobStatus.RUNNING }],
          [JobEvent.START_WITH_PREVIEW, { target: JobStatus.PREVIEWING }],
        ]),
      },
      running: {
        id: JobStatus.RUNNING,
        meta: {
          defaultMessage: 'The job is being processed',
          active: true,
        },
        on: Object.fromEntries([
          [JobEvent.COMPLETE, { target: JobStatus.SUCCESSFUL }],
          [JobEvent.COMPLETE_WITH_ERRORS, { target: JobStatus.COMPLETE_WITH_ERRORS }],
          [JobEvent.CANCEL, { target: JobStatus.CANCELED }],
          [JobEvent.FAIL, { target: JobStatus.FAILED }],
          [JobEvent.PAUSE, { target: JobStatus.PAUSED }],
        ]),
      },
      running_with_errors: {
        id: JobStatus.RUNNING_WITH_ERRORS,
        meta: {
          defaultMessage: 'The job is being processed, but some items have failed processing',
          active: true,
        },
        on: Object.fromEntries([
          [JobEvent.COMPLETE, { target: JobStatus.SUCCESSFUL }],
          [JobEvent.COMPLETE_WITH_ERRORS, { target: JobStatus.COMPLETE_WITH_ERRORS }],
          [JobEvent.CANCEL, { target: JobStatus.CANCELED }],
          [JobEvent.FAIL, { target: JobStatus.FAILED }],
          [JobEvent.PAUSE, { target: JobStatus.PAUSED }],
        ]),
      },
      successful: {
        id: JobStatus.SUCCESSFUL,
        meta: {
          defaultMessage: 'The job has completed successfully',
        },
        type: 'final',
      },
      complete_with_errors: {
        id: JobStatus.COMPLETE_WITH_ERRORS,
        meta: {
          defaultMessage: 'The job has completed with errors. See the errors field for more details',
        },
        type: 'final',
      },
      failed: {
        id: JobStatus.FAILED,
        meta: {
          defaultMessage: 'The job failed with an unknown error',
        },
        type: 'final',
        on: Object.fromEntries([
          // allow retrigger of failure to simplify error handling
          [JobEvent.FAIL, { target: JobStatus.FAILED }],
        ]),
      },
      canceled: {
        id: JobStatus.CANCELED,
        meta: {
          defaultMessage: 'The job was canceled',
        },
        type: 'final',
      },
      previewing: {
        id: JobStatus.PREVIEWING,
        meta: {
          defaultMessage: 'The job is generating a preview before auto-pausing',
          active: true,
        },
        on: Object.fromEntries([
          [JobEvent.SKIP_PREVIEW, { target: JobStatus.RUNNING }],
          [JobEvent.CANCEL, { target: JobStatus.CANCELED }],
          [JobEvent.FAIL, { target: JobStatus.FAILED }],
          [JobEvent.PAUSE, { target: JobStatus.PAUSED }],
        ]),
      },
      paused: {
        id: JobStatus.PAUSED,
        meta: {
          defaultMessage: 'The job is paused and may be resumed using the provided link',
        },
        on: Object.fromEntries([
          [JobEvent.SKIP_PREVIEW, { target: JobStatus.RUNNING }],
          [JobEvent.RESUME, { target: JobStatus.RUNNING }],
          [JobEvent.CANCEL, { target: JobStatus.CANCELED }],
          [JobEvent.FAIL, { target: JobStatus.FAILED }],
        ]),
      },
    },
  },
);

export const terminalStates = Object.keys(stateMachine.states)
  .filter(key => stateMachine.states[key].type === 'final')
  .map(k => stateMachine.states[k].id) as JobStatus[];

export const activeJobStatuses = Object.keys(stateMachine.states)
  .filter(key => stateMachine.states[key].meta.active)
  .map(k => stateMachine.states[k].id);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const statesToDefaultMessages: any = Object.values(stateMachine.states).reduce(
  (prev, state) => {
    prev[state.id] = state.meta.defaultMessage;
    return prev;
  },
  {});

/**
 * Check if a desired transition (for job status) is acceptable according to the state machine.
 * @param currentStatus - the current job status
 * @param desiredStatus - the desired job status
 * @param event - the event that would precipitate the transition
 * @returns boolean true if the transition is valid
 */
export function canTransition(
  currentStatus: JobStatus,
  desiredStatus: JobStatus,
  event: JobEvent,
): boolean {
  const state = stateMachine.transition(currentStatus, event);
  return state.changed && state.matches(desiredStatus);
}

/**
 * Validate that a desired transition (for job status) is acceptable according to the state machine
 * and throw an error if not acceptable.
 * @param currentStatus - the current job status
 * @param desiredStatus - the desired job status
 * @param event - the event that would precipitate the transition
 * @param errorMessage - the error message to throw if the transition is invalid
 * @throws ConflictError if the transition is invalid
 */
export function validateTransition(
  currentStatus: JobStatus,
  desiredStatus: JobStatus,
  event: JobEvent,
  errorMessage = `Job status cannot be updated from ${currentStatus} to ${desiredStatus}.`,
): void {
  if (!canTransition(currentStatus, desiredStatus, event)) {
    throw new ConflictError(errorMessage);
  }
}

/**
 * Returns only the links with a rel that matches the passed in value.
 *
 * @param rel - the relation to return links for
 * @returns the job output links with the given rel
 */
export function getRelatedLinks(rel: string, links: JobLink[]): JobLink[] {
  const relatedLinks = links.filter((link) => link.rel === rel);
  return relatedLinks.map(removeEmptyProperties) as JobLink[];
}

/**
 * Get all of the unique provider Ids.
 * @param tx - the transaction to use for querying
 * @returns a promise resolving to an array of provider Ids
 */
async function getUniqueProviderIds(tx: Transaction): Promise<string[]> {
  const results = await tx('jobs')
    .whereNotNull('provider_id')
    .distinct('provider_id');
  return results.map((job) => job.provider_id);
}

/**
 * Sets the fields on the where clauses (see JobQuery) to be prefixed with a table name to avoid
 * ambiguities when joining with other tables
 * @param table - the table name to prefix to the field name
 * @param whereClauses - the where clauses to process
 * @returns An object with its fields prefixed with the table name
 */
function setTableNameForWhereClauses(table: string, whereClauses: {}): {} {
  const result = {};
  Object.entries(whereClauses).forEach(([key, value]) => {
    if (value !== undefined) {
      result[`${table}.${key}`] = value;
    }
  });

  return result;
}

/**
 * Conditionally modify a job query if specific constraints are present.
 * @param queryBuilder - the knex query builder object to modify
 * @param constraints - specifies the query constraints (if any)
 */
function modifyQuery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryBuilder: Knex.QueryBuilder<any, any>,
  constraints: JobQuery): void {
  if (constraints === undefined) return;
  if (constraints.whereIn) {
    constraints.whereIn = setTableNameForWhereClauses('jobs', constraints.whereIn);
    for (const jobField in constraints.whereIn) {
      const constraint = constraints.whereIn[jobField];
      if (constraint.in) {
        void queryBuilder.whereIn(jobField, constraint.values);
      } else {
        void queryBuilder.whereNotIn(jobField, constraint.values);
      }
    }
  }
  if (constraints.dates) {
    if (constraints.dates.from) {
      void queryBuilder.where(constraints.dates.field, '>=', constraints.dates.from);
    }
    if (constraints.dates.to) {
      void queryBuilder.where(constraints.dates.field, '<=', constraints.dates.to);
    }
  }
}

/**
 *
 * Wrapper object for persisted jobs
 *
 * Fields:
 *   - id: (integer) auto-number primary key
 *   - jobID: (uuid) ID for the job, currently the same as the requestId, but may change
 *   - username: (string) Earthdata Login username
 *   - requestId: (uuid) ID of the originating user request that produced the job
 *   - status: (enum string) job status ['accepted', 'running', 'successful', 'failed']
 *   - message: (string) human readable status message
 *   - progress: (integer) 0-100 approximate completion percentage
 *   - links: (JSON) links to output files, array of objects containing the following keys:
 *       "href", "title", "type", and "rel"
 *   - request: (string) Original user request URL that created this job
 *   - createdAt: (Date) the date / time at which the job was created
 *   - updatedAt: (Date) the date / time at which the job was last updated
 *   - dataExpiration: (Date) the date / time at which the generated data will be deleted
 */
export class Job extends DBRecord implements JobRecord {
  static table = 'jobs';

  static statuses: JobStatus;

  links: JobLink[];

  errors: JobError[];

  private statesToMessages: { [key in JobStatus]?: string };

  username: string;

  requestId: string;

  progress: number;

  dataExpiration?: Date;

  batchesCompleted: number;

  request: string;

  isAsync: boolean;

  status: JobStatus;

  jobID: string;

  originalStatus: JobStatus;

  numInputGranules: number;

  collectionIds: string[];

  ignoreErrors: boolean;

  destination_url?: string;

  service_name?: string;

  provider_id?: string;

  labels: string[];

  /**
   * Get the job message for the current status.
   * @returns the message string describing the job
   */
  get message(): string {
    return this.getMessage(this.status);
  }

  /**
   * Set the job message for the current status.
   * @param message - a message string describing the job
   */
  set message(message: string) {
    this.setMessage(message, this.status);
  }

  /**
   * Get the job message for a particular status.
   * @param status - the JobStatus that the message is for (defaults to this.status)
   * @returns the message string describing the job
   */
  getMessage(status: JobStatus = this.status): string {
    return this?.statesToMessages?.[status] || statesToDefaultMessages[status];
  }

  /**
   * Set the job message for a particular status.
   * @param message - a message string describing the job
   * @param status - which status to set the message for (defaults to this.status)
   */
  setMessage(message: string, status: JobStatus = this.status): void {
    if (!message) {
      return;
    }
    this.statesToMessages ??= {};
    this.statesToMessages[status] = message;
  }

  /**
   * Returns an array of all jobs that match the given constraints
   *
   * @param tx - the transaction to use for querying
   * @param constraints - field / value pairs that must be matched for a record to be returned
   * @param currentPage - the index of the page to show
   * @param perPage - the number of results per page
   * @returns a list of all of the user's jobs
   */
  static async queryAll(
    tx: Transaction,
    constraints: JobQuery = { where: {} },
    currentPage = 0,
    perPage = 10,
    includeLabels = false,
  ): Promise<{ data: Job[]; pagination: ILengthAwarePagination }> {
    let query;

    if (includeLabels) {
      query = tx(Job.table)
        .select(`${Job.table}.*`, tx.raw(`STRING_AGG(${LABELS_TABLE}.value, ',' order by value) AS label_values`))
        .leftOuterJoin(`${JOBS_LABELS_TABLE}`, `${Job.table}.jobID`, '=', `${JOBS_LABELS_TABLE}.job_id`)
        .leftOuterJoin(`${LABELS_TABLE}`, `${JOBS_LABELS_TABLE}.label_id`, '=', `${LABELS_TABLE}.id`)
        .where(setTableNameForWhereClauses(Job.table, constraints.where))
        .groupBy(`${Job.table}.id`)
        .orderBy(
          constraints?.orderBy?.field ?? 'createdAt',
          constraints?.orderBy?.value ?? 'desc')
        .modify((queryBuilder) => modifyQuery(queryBuilder, constraints));
    } else {
      query = tx(Job.table)
        .select()
        .where(constraints.where)
        .orderBy(
          constraints?.orderBy?.field ?? 'createdAt',
          constraints?.orderBy?.value ?? 'desc')
        .modify((queryBuilder) => modifyQuery(queryBuilder, constraints));
    }

    query = query.paginate({ currentPage, perPage, isLengthAware: true });
    const items = await query;

    const jobs: Job[] = items.data.map((j: JobWithLabels) => {
      const job = new Job(j);
      if (includeLabels && j.label_values) {
        job.labels = j.label_values.split(',');
      } else {
        job.labels = [];
      }
      return job;
    });

    return {
      data: jobs,
      pagination: items.pagination,
    };
  }

  /**
   * Returns the job matching the given query constraints, or null if no such job exists.
   *
   * @param tx - the transaction to use for querying
   * @param constraints - field / value pairs that must be matched for a record to be returned
   * @param includeLinks - if true, load all JobLinks into job.links
   * @param currentPage - the index of the page of links to show
   * @param perPage - the number of link results per page
   * @returns the matching job, or null if none exists, along with pagination information
   * for the job links
   */
  static async queryForSingleJob(
    tx: Transaction,
    constraints: JobQuery = {},
    includeLinks = false,
    includeLabels = false,
    lock = false,
    currentPage = 0,
    perPage = env.defaultResultPageSize,
  ): Promise<{ job: Job; pagination: ILengthAwarePagination }> {
    let query = tx(Job.table).first().where(constraints.where);
    if (lock) {
      query = query.forUpdate();
    }
    const result = await query;
    const job = result ? new Job(result) : null;
    let paginationInfo;
    if (job) {
      if (includeLinks) {
        const linkData = await getLinksForJob(tx, job.jobID, currentPage, perPage);
        job.links = linkData.data;
        paginationInfo = linkData.pagination;
      }
      if (includeLabels) {
        job.labels = await getLabelsForJob(tx, job.jobID);
      }
    }
    return { job, pagination: paginationInfo };
  }

  /**
   * Returns an array of all jobs for the given username using the given transaction
   *
   * @param transaction - the transaction to use for querying
   * @param username - the user whose jobs should be retrieved
   * @param currentPage - the index of the page to show
   * @param perPage - the number of results per page
   * @returns a list of all of the user's jobs
   */
  static forUser(tx: Transaction, username: string, currentPage = 0, perPage = 10):
  Promise<{ data: Job[]; pagination: ILengthAwarePagination }> {
    return Job.queryAll(tx, { where: { username } }, currentPage, perPage);
  }

  /**
  * Returns a Job with the given jobID using the given transaction
  * Optionally locks the row.
  *
  * @param transaction - the transaction to use for querying
  * @param jobID - the jobID for the job that should be retrieved
  * @param includeLinks - if true include the job links when returning the job
  * @param includeLabels - if true include the labels when returning the job
  * @param lock - if true lock the row in the jobs table
  * @param currentPage - the index of the page of job links to show
  * @param perPage - the number of job links to include per page
  * @returns the Job with the given JobID or null if not found
  */
  static async byJobID(
    tx: Transaction, jobID: string, includeLinks = false, includeLabels = false, lock = false, currentPage = 0,
    perPage = env.defaultResultPageSize,
  ): Promise<{ job: Job; pagination: ILengthAwarePagination }> {
    const constraints = { where: { jobID } };
    return Job.queryForSingleJob(tx, constraints, includeLinks, includeLabels, lock, currentPage, perPage);
  }

  /**
  * Returns the number of input granules for the given jobID
  *
  * @param tx - the database transaction to use for querying
  * @param jobID - the jobID for the job that should be retrieved
  * @returns the number of input granules for the job
  */
  static async getNumInputGranules(tx: Transaction, jobID: string): Promise<number> {
    const results = await tx(Job.table)
      .select('numInputGranules')
      .where({ jobID });

    return results[0].numInputGranules;
  }

  /**
   * Returns the job matching the given username and job ID, or null if
   * no such job exists.
   *
   * @param tx - the transaction to use for querying
   * @param username - the username associated with the job
   * @param jobID - the job ID for the request
   * @param includeLinks - if true, load all JobLinks into job.links
   * @param includeLabels - if true include labels with the job
   * @param lock - if true lock the row in the jobs table
   * @param currentPage - the index of the page of links to show
   * @param perPage - the number of link results per page
   * @returns the matching job, or null if none exists, along with pagination information
   * for the job links
   */
  static async byUsernameAndJobID(
    tx,
    username,
    jobID,
    includeLinks = false,
    includeLabels = false,
    lock = false,
    currentPage = 0,
    perPage = env.defaultResultPageSize,
  ): Promise<{ job: Job; pagination: ILengthAwarePagination }> {
    const constraints = { where: { username, jobID } };
    return Job.queryForSingleJob(tx, constraints, includeLinks, includeLabels, lock, currentPage, perPage);
  }

  /**
   * Returns the time of the most recently updated job
   *
   * @param tx - the transaction to use for querying
   * @returns a promise resolving to the timestamp of the most recently updated job
   */
  static async getTimeOfMostRecentlyUpdatedJob(tx: Transaction): Promise<Date> {
    const response = await tx(Job.table).max('updatedAt as latest_update');
    return new Date(response[0].latest_update);
  }


  /**
   * Get a list of unique provider ids (singleton, loaded once per server startup)
   * @param tx - the transaction to use for querying
   * @param logger - the logger to use
   * @returns list of provider ids as a string[]
   */
  static async getProviderIdsSnapshot(tx: Transaction, logger: Logger): Promise<string[]> {
    if (providerIdsSnapshot === undefined) {
      try {
        providerIdsSnapshot = await getUniqueProviderIds(tx);
      } catch (e) {
        logger.error(e);
        providerIdsSnapshot = [];
      }
    }
    return providerIdsSnapshot;
  }

  /**
   * Creates a Job instance.
   *
   * @param fields - Object containing fields to set on the record
   */
  constructor(fields: JobRecord) {
    super(fields);
    let initialMessage: string;
    try {
      // newer jobs will have stringified JSON stored in the database
      this.statesToMessages = JSON.parse(fields.message);
      initialMessage = this.message;
    } catch (e) {
      if (!(e instanceof SyntaxError)) {
        throw e;
      }
      // this implies that the message is a plain string, i.e.
      // (a) we're initializing an older job from a databse record or
      // (b) a JobRecord that is not emanating from the database
      initialMessage = fields.message;
    }
    this.updateStatus(fields.status || JobStatus.ACCEPTED, initialMessage);
    this.progress = fields.progress || 0;
    this.batchesCompleted = fields.batchesCompleted || 0;
    this.links = fields.links ? fields.links.map((l) => new JobLink(l)) : [];
    // collectionIds is stringified JSON when returned from database
    this.collectionIds = (typeof fields.collectionIds === 'string'
      ? JSON.parse(fields.collectionIds) : fields.collectionIds)
      || [];
    // Job already exists in the database
    if (fields.createdAt) {
      this.originalStatus = this.status;
    }

    // Make sure this field gets set to a boolean
    this.ignoreErrors = fields.ignoreErrors || false;
  }

  /**
   * Validates the job. Returns null if the job is valid.  Returns a list of errors if
   * it is invalid. Other constraints are validated via database constraints.
   *
   * @returns a list of validation errors, or null if the record is valid
   */
  validate(): string[] {
    const errors = [];
    if (this.progress < 0 || this.progress > 100) {
      errors.push(`Invalid progress ${this.progress}. Job progress must be between 0 and 100.`);
    }
    if (this.batchesCompleted < 0) {
      errors.push(`Invalid batchesCompleted ${this.batchesCompleted}. Job batchesCompleted must be greater than or equal to 0.`);
    }
    if (!this.request.match(/^https?:\/\/.+$/)) {
      errors.push(`Invalid request ${this.request}. Job request must be a URL.`);
    }
    return errors.length === 0 ? null : errors;
  }

  /**
   * Throws an exception if attempting to change the status on a request that's already in a
   * terminal state.
   */
  validateStatus(): void {
    if (terminalStates.includes(this.originalStatus)) {
      throw new ConflictError(`Job status cannot be updated from ${this.originalStatus} to ${this.status}.`);
    }
  }

  /**
   * Adds a link to the list of result links for the job.
   * You must call `#save` to persist the change
   *
   * @param link - Adds a link to the list of links for the object.
   */
  addLink(link: JobLink): void {
    // eslint-disable-next-line no-param-reassign
    link.jobID = this.jobID;
    this.links.push(link);
  }

  /**
   * Adds a staging location link to the list of result links for the job.
   * You must call `#save` to persist the change
   *
   * @param stagingLocation - Adds link to the staging bucket to the list of links.
   */
  addStagingBucketLink(stagingLocation): void {
    if (stagingLocation) {
      const stagingLocationLink = new JobLink({
        href: stagingLocation,
        title: stagingBucketTitle,
        rel: 's3-access',
      });
      this.addLink(stagingLocationLink as JobLink);
    }
  }

  /**
   *  Checks the status of the job to see if the job is paused.
   *
   * @returns true if the `Job` is paused or previewing
   */
  isPaused(): boolean {
    return [JobStatus.PAUSED, JobStatus.PREVIEWING].includes(this.status);
  }

  /**
   * Updates the status to paused.
   * Only jobs in the RUNNING state may be paused.
   * You must call `#save` to persist the change.
   *
   * @throws An error if the job is not currently in the RUNNING state
   */
  pause(): void {
    validateTransition(this.status, JobStatus.PAUSED, JobEvent.PAUSE);
    this.updateStatus(JobStatus.PAUSED, this.getMessage(JobStatus.PAUSED));
  }

  /**
   * Sets the status to paused, and sets the ready count for the user_work for the job to 0.
   *
   * @param tx - the database transaction to use for querying
   * @throws An error if the job is not currently in the RUNNING state
   */
  async pauseAndSave(tx): Promise<void> {
    validateTransition(this.status, JobStatus.PAUSED, JobEvent.PAUSE);
    this.updateStatus(JobStatus.PAUSED, this.getMessage(JobStatus.PAUSED));
    await this.save(tx);
    await setReadyCountToZero(tx, this.jobID);
  }

  /**
   * Updates the status of a paused job to running.
   *
   * @throws An error if the job is not currently in the PAUSED state
   */
  resume(): void {
    validateTransition(this.status, JobStatus.RUNNING, JobEvent.RESUME,
      `Job status is ${this.status} - only paused jobs can be resumed.`);
    this.updateStatus(JobStatus.RUNNING, this.getMessage(JobStatus.RUNNING));
  }

  /**
   * Updates the status of a previewing job to running.
   *
   * @throws An error if the job is not currently in the PREVIEWING state
   */
  skipPreview(): void {
    validateTransition(this.status, JobStatus.RUNNING, JobEvent.SKIP_PREVIEW,
      `Job status is ${this.status} - only previewing jobs can skip preview.`);
    this.updateStatus(JobStatus.RUNNING, this.getMessage(JobStatus.RUNNING));
  }

  /**
   * Updates the status to failed and message to the supplied error message or the default
   * if none is provided.  You should generally provide an error message if possible, as the
   * default indicates an unknown error.
   * You must call `#save` to persist the change
   *
   * @param message - an error message
   */
  fail(message = statesToDefaultMessages.failed): void {
    validateTransition(this.status, JobStatus.FAILED, JobEvent.FAIL);
    this.updateStatus(JobStatus.FAILED, message);
  }

  /**
   * Updates the status to canceled, providing the optional message.
   * You must call `#save` to persist the change
   *
   * @param message - an error message
   */
  cancel(message = statesToDefaultMessages.canceled): void {
    validateTransition(this.status, JobStatus.CANCELED, JobEvent.CANCEL);
    this.updateStatus(JobStatus.CANCELED, message);
  }

  /**
   * Updates the status to success, providing the optional message.  Generally you should
   * only set a message if there is information to provide to users about the result, as
   * providing a message will override any prior message, including warnings.
   * You must call `#save` to persist the change
   *
   * @param message - (optional) a human-readable status message.  See method description.
   */
  succeed(message?: string): void {
    validateTransition(this.status, JobStatus.SUCCESSFUL, JobEvent.COMPLETE);
    this.updateStatus(JobStatus.SUCCESSFUL, message);
  }

  /**
   * Updates the status to complete_with_errors, providing the optional message. Generally you
   * should only set a message if there is information to provide to users about the result, as
   * providing a message will override any prior message, including warnings.
   * You must call `#save` to persist the change
   *
   * @param message - (optional) a human-readable status message.  See method description.
   */
  complete_with_errors(message?: string): void {
    validateTransition(this.status, JobStatus.COMPLETE_WITH_ERRORS, JobEvent.COMPLETE_WITH_ERRORS);
    this.updateStatus(JobStatus.COMPLETE_WITH_ERRORS, message);
  }

  /**
   * Update the status and status message of a job.  If a null or default message is provided,
   * will use a default message corresponding to the status.
   * You must call `#save` to persist the change
   *
   * @param status - The new status, one of successful, failed, running,
   * accepted, running_with_errors, complete_with_errors, paused, previewing
   * @param message - (optional) a human-readable status message
   */
  updateStatus(status: JobStatus, message?: string): void {
    this.status = status;
    if (message) {
      // Update the message if a new one was provided
      this.message = message;
    }
    if (this.status === JobStatus.SUCCESSFUL || this.status === JobStatus.COMPLETE_WITH_ERRORS) {
      this.progress = 100;
    }
  }

  /**
   * Update the progress of a job using the progress of the WorkflowSteps for the job.
   * You must call `#save` to persist the change.
   *
   * @param tx - a transaction to use when querying the database
   * @returns An empty Promise
   */
  async updateProgress(tx: Transaction): Promise<void> {
    const steps = await getWorkflowStepsByJobId(tx, this.jobID, ['workItemCount', 'completed_work_item_count', 'progress_weight']);
    let prevStep: WorkflowStep = null;
    for (const step of steps) {
      step.updateProgress(prevStep);
      prevStep = step;
    }
    let sumOfWeights = steps.reduce((sum: number, step: WorkflowStep) => sum + step.progress_weight, 0);
    sumOfWeights = sumOfWeights > 0 ? sumOfWeights : 1;
    let progSum = steps.reduce((sum: number, step: WorkflowStep) => sum + step.progress_weight * step.progress, 0);
    progSum = Math.max(0, progSum);
    // Only allow progress to be set to 100 when the job completes and don't let progress go
    // backwards
    const progress = Math.min(Math.floor(progSum / sumOfWeights), 99);
    if (this.progress < progress) {
      this.progress = progress;
    }
  }

  /**
   * Updates the number of completed batches. This is no longer used to compute job progress,
   * but it is left in place in the event we want to track batches later.
   * You must call `#save` to persist the change.
   */
  completeBatch(): void {
    this.batchesCompleted += 1;
  }

  /**
   * Returns true if the job status on this instance is currently set to a terminal
   * state, i.e. it expects no further interaction with backend services.
   *
   * @returns true if the job status is a terminal status
   */
  hasTerminalStatus(): boolean {
    return terminalStates.includes(this.status);
  }

  /**
   * Checks whether sharing of this job is restricted by any EULAs for
   * any collection used by this job.
   * Defaults to true if any collection does not have the harmony.has-eula tag
   * associated with it.
   * @param accessToken - the token to make the request with
   * @returns true or false
   */
  async collectionsHaveEulaRestriction(accessToken: string): Promise<boolean> {
    const cmrCollections = await getCollectionsByIds(
      this.collectionIds,
      accessToken,
      CmrTagKeys.HasEula,
    );
    if (cmrCollections.length !== this.collectionIds.length) {
      return true;
    }
    return !cmrCollections.every((collection) => (collection.tags
      && collection.tags[CmrTagKeys.HasEula].data === false));
  }

  /**
   * Checks whether CMR guests are restricted from reading any of the collections used in the job.
   * @param accessToken - the token to make the request with
   * @returns true or false
   */
  async collectionsHaveGuestReadRestriction(accessToken: string): Promise<boolean> {
    const permissionsMap: CmrPermissionsMap = await getPermissions(this.collectionIds, accessToken);
    return this.collectionIds.some((collectionId) => (
      !permissionsMap[collectionId]
        || !(permissionsMap[collectionId].indexOf(CmrPermission.Read) > -1)));
  }

  /**
   * Returns true if a particular user either owns the job in question
   * or belongs to the admin group.
   * @param requestUser - The user name of the user making the request
   * @param isAdmin - Whether the requesting user is an admin.
   * @returns boolean
   */
  belongsToOrIsAdmin(requestUser: string, isAdmin: boolean): boolean {
    return isAdmin || (this.username === requestUser);
  }

  /**
   * Returns true if the job and its results can be shared.
   * @param accessToken - The token used for the CMR API
   * @returns boolean
   */
  async isShareable(accessToken: string): Promise<boolean> {
    if (!this.collectionIds.length) {
      return false;
    }
    if (await this.collectionsHaveEulaRestriction(accessToken)) {
      return false;
    }
    if (await this.collectionsHaveGuestReadRestriction(accessToken)) {
      return false;
    }
    return true;
  }

  /**
   * Check if the job has any links
   *
   * @param tx - transaction to use for the query
   * @param rel - if set, only check for job links with this rel type
   * @param requireSpatioTemporal - if true, only check for job links
   *  with spatial and temporal constraints
   * @returns true or false
   */
  async hasLinks(
    tx,
    rel?: string,
    requireSpatioTemporal = false,
  ): Promise<boolean> {
    const { data } = await getLinksForJob(
      tx, this.jobID, 1, 1, rel, requireSpatioTemporal,
    );
    return data.length !== 0;
  }

  /**
   * Validates and saves the job using the given transaction.  Throws an error if the
   * job is not valid.  New jobs will be inserted and have their id, createdAt, and
   * updatedAt fields set.  Existing jobs will be updated and have their updatedAt
   * field set.
   *
   * @param tx - The transaction to use for saving the job
   * @throws {@link Error} if the job is invalid
   */
  async save(tx: Transaction): Promise<void> {
    const reservedMessageChars = 1000; // reserve 1k chars for non-failure messages (which tend to be smaller)
    // Need to validate the original status before removing it as part of saving to the database
    // May want to change in the future to have a way to have non-database fields on a record.
    this.validateStatus();
    const truncatedFailureMessage = truncateString(this.getMessage(JobStatus.FAILED), TEXT_LIMIT - reservedMessageChars);
    this.setMessage(truncatedFailureMessage, JobStatus.FAILED);
    this.request = truncateString(this.request, TEXT_LIMIT);
    const dbRecord: Record<string, unknown> = pick(this, jobRecordFields);
    dbRecord.collectionIds = JSON.stringify(this.collectionIds || []);
    dbRecord.message = JSON.stringify(this.statesToMessages || {});
    await super.save(tx, dbRecord);
    const promises = [];
    for (const link of this.links) {
      // Note we will not update existing links in the database - only add new ones
      if (!link.id) {
        promises.push(link.save(tx));
      }
    }
    await Promise.all(promises);
    await setLabelsForJob(tx, this.jobID, this.username, this.labels);
  }

  /**
   * Serializes a Job to return from any of the jobs frontend endpoints
   * @param urlRoot - the root URL to be used when constructing links
   * @param linkType - the type to use for data links (http|https =\> https | s3 =\> s3 | none)
   * @returns an object with the serialized job fields.
   */
  serialize(urlRoot?: string, linkType?: string): JobForDisplay {
    let serializedJob: JobForDisplay = {
      username: this.username,
      status: this.status,
      message: this.message,
      progress: this.progress,
      createdAt: new Date(this.createdAt),
      updatedAt: new Date(this.updatedAt),
      dataExpiration: this.getDataExpiration(),
      links: this.links,
      labels: this.labels,
      request: this.request,
      numInputGranules: this.numInputGranules,
      jobID: this.jobID,
    };
    // need this line to prevent null values from showing up in data expiration field
    serializedJob = removeEmptyProperties(serializedJob) as JobForDisplay;

    if (urlRoot && linkType !== 'none') {
      serializedJob.links = serializedJob.links.map((link) => {
        const serializedLink = link.serialize();
        let { href } = serializedLink;
        const { title, type, rel, bbox, temporal } = serializedLink;
        // Leave the S3 output staging location as an S3 link
        if (rel !== 's3-access' && !this.destination_url) {
          href = createPublicPermalink(href, urlRoot, type, linkType);
        }
        return removeEmptyProperties({ href, title, type, rel, bbox, temporal });
      }) as unknown as JobLink[];
    }
    return serializedJob;
  }

  /**
   * Returns only the links with a rel that matches the passed in value.
   *
   * @param rel - the relation to return links for
   * @returns the job output links with the given rel
   */
  getRelatedLinks = (rel: string): JobLink[] => getRelatedLinks(rel, this.links);

  /**
   *  Computes and returns the date the data produced by the job will expire based on `createdAt`
   *
   * @returns the date the data produced by the job will expire, or null if there is no expiration
   */
  getDataExpiration(): Date {
    let result = null;
    if (!this.destination_url) {
      const expiration = new Date(this.createdAt);
      expiration.setUTCDate(expiration.getUTCDate() + EXPIRATION_DAYS);
      result = expiration;
    }

    return result;
  }


}

interface JobWithLabels extends Job {
  label_values: string; // comma-separated list
}
