import { Transaction } from './../util/db';
import Record from './record';
import WorkItem from './work-item';

/**
 *
 * Wrapper object for aggregated information tracking the work items summary for a job and service
 *
 */
export default class UserWork extends Record {
  static table = 'user_work';

  // The ID of the job
  jobID: string;

  // unique identifier for the service - this should be the docker image tag (with version)
  serviceID: string;

  // The username associated with the job
  username: string;

  // the number of work items in the ready state for this job and service
  readyCount: number;

  // the number of work items in the running state for this job and service
  runningCount: number;

  // the time the job was last worked
  lastWorked: Date;
}

/**
 * Get user work record for jobID and serviceID
 *
 */

/**
 * Get a count of work items in the ready or running state for the given service ID
 *
 * @param tx - The database transaction
 * @param serviceID - The ID of the service
 * @returns The sum of ready and running work items for the service
 */
export async function getQueuedAndRunningCountForService(tx: Transaction, serviceID: string)
  : Promise<number> {
  const results = await tx(UserWork.table)
    .sum('ready_count').as('ready')
    .sum('running_count').as('running') // : 'running_count as running' })
    .where({ service_id: serviceID });

  let count = 0;
  count = Number(results[0].ready) + Number(results[0].running);

  return count;
}

/**
 * Gets the next username that should have a work item worked for the given service ID
 * SELECT username, SUM("u"."running_count") as s from user_work u WHERE username in
 * (SELECT DISTINCT username FROM user_work u WHERE "u"."service_id" = 'ghcr.io/podaac/l2ss-py:2.2.0' AND "u"."ready_count" \> 0)
 * GROUP BY username order by s, max(last_worked) asc LIMIT 1;

 * @param tx - The database transaction
 * @param serviceID - The ID of the service
 * @returns The username that should have a work item worked next
 */
export async function getNextUsernameForWork(tx: Transaction, serviceID: string)
  : Promise<string> {
  const subquery = tx(UserWork.table)
    .distinct('username')
    .where('service_id', '=', serviceID)
    .where('ready_count',  '>',  0);

  // GROUP BY username order by s, max(last_worked) asc LIMIT 1;
  const results = await tx(UserWork.table)
    .select('username')
    .max('last_worked as lw')
    .sum('running_count as rc')
    .whereIn('username', subquery)
    .groupBy('username')
    .orderBy('rc', 'asc')
    .orderBy('lw', 'asc')
    .first();

  return results?.username;
}

/**
 * Gets the next job to work on for the given username and service ID.
 * select job_id from user_work where username = <username> and ready_count \> 0 order by last_worked asc limit 1
 * @param tx - The database transaction
 * @param serviceID - The ID of the service
 * @param username - The username to choose a job to work on
 * @returns The job ID that should have a work item worked next for the service
 */
export async function getNextJobIdForUsernameAndService(tx: Transaction, serviceID: string, username: string)
  : Promise<string> {
  const results = await tx(UserWork.table)
    .select('job_id')
    .where({ username, service_id: serviceID })
    .where('ready_count', '>', 0)
    .orderBy('last_worked', 'asc')
    .first();

  return results.job_id;
}

// export async function insertUserWork(tx: Transaction, userWork: Partial<UserWork>)
//   : Promise<string> {
//   const results = await tx(UserWork.table).insert(userWork);
// }
// 10 more to go
// Just use the generic save record function for any kind of inserts

/**
 * Deletes all of the rows for the given job from the user_work table.
 * delete from user_work where job_id = $job_id
 * @param tx - The database transaction
 * @param jobID - The job ID
 * @returns the number of rows deleted
 */
export async function deleteUserWorkForJob(tx: Transaction, jobID: string): Promise<number> {
  const numDeleted = await tx(UserWork.table)
    .where({ job_id: jobID })
    .del();
  return numDeleted;
}

/**
 * Deletes all of the rows for the given job from the user_work table.
 * delete from user_work where job_id = $job_id
 * @param tx - The database transaction
 * @param jobID - The job ID
 * @param serviceID - The ID of the service
 * @returns the number of rows deleted
 */
export async function deleteUserWorkForJobAndService(
  tx: Transaction, jobID: string, serviceID: string,
): Promise<number> {
  const numDeleted = await tx(UserWork.table)
    .where({ job_id: jobID, service_id: serviceID })
    .del();
  return numDeleted;
}

/**
 * Adds one to the ready_count for the given jobID and serviceID.
 * @param tx - The database transaction
 * @param jobID - The job ID
 * @param additionalReadyCount - additional number of items that are now ready - defaults to 1
 * @param serviceID - The ID of the service
 */
export async function incrementReadyCount(
  tx: Transaction, jobID: string, serviceID: string, additionalReadyCount = 1,
): Promise<void> {
  await tx(UserWork.table)
    .where({ job_id: jobID, service_id: serviceID })
    .increment('ready_count', additionalReadyCount);
}

/**
 * Sets the ready_count to 0 for the given jobID.
 * @param tx - The database transaction
 * @param jobID - The job ID
 */
export async function setReadyCountToZero(tx: Transaction, jobID: string): Promise<void> {
  await tx(UserWork.table)
    .where({ job_id: jobID })
    .update('ready_count', 0);
}

/**
 * TODO
 * Sets the ready_count to the appropriate value for each row in the user_work table for the
 * provided jobID.
 * @param tx - The database transaction
 * @param jobID - The job ID
 */
export async function recalculateReadyCount(tx: Transaction, jobID: string): Promise<void> {
  // First get the rows for each service for that jobID
  // TODO
  const rows = await tx(UserWork.table)
    .select(['id', 'serviceID'])
    .where({ job_id: jobID });

  for (const row of rows) {
    const readyCount = await tx(WorkItem.table)
      .count()
      .where({ jobID, serviceID: row.serviceID })
      .first();
    // Then set the ready count for each of those rows
    await tx(UserWork.table)
      .where({ id: row.id })
      .update('ready_count', readyCount);
  }
}

/**
 * Adds one to the running_count and subtracts one from the ready_count for the given
 * jobID and serviceID.
 * @param tx - The database transaction
 * @param jobID - The job ID
 * @param serviceID - The ID of the service
 */
export async function incrementRunningAndDecrementReadyCounts(
  tx: Transaction, jobID: string, serviceID: string,
): Promise<void> {
  await tx(UserWork.table)
    .where({ job_id: jobID, service_id: serviceID })
    .increment('running_count')
    .decrement('ready_count');
}

/**
 * Adds one to the ready_count and subtracts one from the running_count for the given
 * jobID and serviceID.
 * @param tx - The database transaction
 * @param jobID - The job ID
 * @param serviceID - The ID of the service
 */
export async function incrementReadyAndDecrementRunningCounts(
  tx: Transaction, jobID: string, serviceID: string,
): Promise<void> {
  await tx(UserWork.table)
    .where({ job_id: jobID, service_id: serviceID })
    .increment('ready_count')
    .decrement('running_count');
}

/**
 * Decrements the running_count by one for the given jobID and serviceID.
 * @param tx - The database transaction
 * @param jobID - The job ID
 * @param serviceID - The ID of the service
 */
export async function decrementRunningCount(
  tx: Transaction, jobID: string, serviceID: string,
): Promise<void> {
  await tx(UserWork.table)
    .where({ job_id: jobID, service_id: serviceID })
    .decrement('running_count');
}

/**
 * Deletes any rows with 0 running_count and 0 ready_count
 * @param tx - The database transaction
 * @returns the number of rows deleted
 */
export async function deleteOrphanedRows(tx: Transaction): Promise<number> {
  const numDeleted = await tx(UserWork.table)
    .where({ ready_count: 0, running_count: 0 })
    .del();
  return numDeleted;
}

/**
 * Populates the user_work table from scratch using the work_items table.
 * @param tx - The database transaction
 */
export async function popuateUserWorkFromWorkItems(tx: Transaction): Promise<void> {
  const sql = 'INSERT INTO user_work(ready_count, running_count, last_worked, service_id, '
    + 'job_id, username, "createdAt", "updatedAt") '
    + 'SELECT count(1) filter (WHERE i.status = \'ready\') as ready_count, '
    + 'count(1) filter (WHERE i.status = \'running\') as running_count, '
    + '"j"."updatedAt", i."serviceID", "i"."jobID", j.username, now(), now() '
    + 'FROM work_items i, jobs j WHERE "i"."jobID" = "j"."jobID" '
    + 'AND j.status not in (\'paused\', \'previewing\') '
    + 'AND "i"."status" in (\'ready\', \'running\') '
    + 'GROUP BY "j"."updatedAt", "i"."serviceID", "i"."jobID", j.username '
    + 'ORDER BY "j"."updatedAt" asc';
  await tx.raw(sql);
}