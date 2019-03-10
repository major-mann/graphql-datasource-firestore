module.exports = createGraphqlFirebaseSource;

const createGraphqlDatasource = require('@major-mann/graphql-datasource-base');
const { FieldPath } = require('@google-cloud/firestore');

function createGraphqlFirebaseSource({ firestore, definitions, graphqlOptions, common }) {
    const collections = {};
    const source = createGraphqlDatasource({ data: loadCollection, definitions, graphqlOptions, common });
    return source;

    async function loadCollection(name, idField) {
        if (collections[name]) {
            return collections[name];
        }

        const collection = firestore.collection(name);
        collections[name] = {
            find,
            list,
            create,
            upsert,
            update,
            delete: remove
        };
        return collections[name];

        async function create(id, data) {
            if (id) {
                await collection.doc(id).create(data);
                return id;
            } else {
                const doc = await collection.add(data);
                return doc.id;
            }
        }

        async function upsert(id, data) {
            await collection.doc(id).update(data);
        }

        async function update(id, data) {
            await collection.doc(id).update(data, { merge: true });
        }

        async function remove(id) {
            await collection.doc(id).delete();
        }

        async function find(id) {
            const record = await collection
                .doc(id)
                .get();
            if (record.exists) {
                return {
                    [idField]: record.id,
                    ...record.data()
                };
            } else {
                return undefined;
            }
        }

        async function list({ filter, order, cursor, limit }) {
            let query = collection;

            if (filter) {
                filter.forEach(processFilter);
            }

            if (order) {
                order.forEach(processOrder);
            }

            if (cursor) {
                await processCursor(cursor);
            }

            if (limit > 0) {
                query = query.limit(parseInt(limit));
            }

            const snapshot = await query.get();
            const records = [];
            snapshot.forEach(record => records.push({
                [idField]: record.id,
                ...record.data()
            }));

            const edges = records.map(function processRecord(record) {
                return {
                    // TODO: Need the fields passed in to this function....
                    // TODO: Avoid supplying cursor if not requested
                    //      info.fieldNodes[].selectionSet.selections[].name.value
                    cursor: createCursor(record, true, true),
                    node: record
                };
            });

            return {
                edges,
                pageInfo: pageInfo(records[0], records[records.length - 1])
            };

            function pageInfo(first, last) {
                // TODO: Need the selected fields passed in to this function....
                // TODO: Avoid supplying cursor if not requested
                    //      info.fieldNodes[].selectionSet.selections[].name.value
                return {
                    previousPage: first && createCursor(first, false, false),
                    nextPage: last && createCursor(last, true, false)
                };
            }

            function processFilter(filter) {
                query = query.where(filter.field, operator(filter.op), filter.value);
            }

            function processOrder(order) {
                const args = [order.field];
                if (order.desc) {
                    args.push('desc');
                }
                query = query.orderBy(...args);
            }

            function processCursor(serializedCursor) {
                const cursor = deserializeCursor(serializedCursor);

                if (cursor.idCursor && (!order ||  !order.length)) {
                    query = query.orderBy(FieldPath.documentId());
                }

                if (cursor.idCursor && cursor.after) {
                    query = query.startAt(...cursor.value);
                } else if (cursor.inclusive) {
                    query = query.endAt(...cursor.value);
                } else if (cursor.after) {
                    query = query.startAfter(...cursor.value);
                } else {
                    query = query.endBefore(...cursor.value);
                }
            }

            function createCursor(data, after, inclusive) {
                if (!data) {
                    return undefined;
                }
                const cursor = {
                    after,
                    inclusive
                };
                if (order && order.length) {
                    cursor.idCursor = false;
                    cursor.value = order.map(order => data[order.field]);
                } else {
                    cursor.idCursor = true;
                    cursor.value = [data[idField]];
                }
                return serializeCursor(cursor);
            }

            function serializeCursor(cursor) {
                const fieldDataSource = JSON.stringify(cursor.value);
                const fieldData = fieldDataSource.substring(1, fieldDataSource.length - 1);
                const fieldDataByteLength = Buffer.byteLength(fieldData)
                const buffer = Buffer.allocUnsafe(3 + fieldDataByteLength);
                buffer[0] = cursor.after ? 1 : 0;
                buffer[1] = cursor.inclusive ? 1 : 0;
                buffer[2] = cursor.idCursor ? 1 : 0;
                buffer.write(fieldData, 3, fieldDataByteLength, 'utf8');
                return buffer.toString('base64');
            }

            function deserializeCursor(source) {
                const buffer = Buffer.from(source, 'base64');
                const after = buffer[0] === 1;
                const inclusive = buffer[1] === 1;
                const idCursor = buffer[2] === 1;
                const value = JSON.parse(`[${buffer.slice(3).toString('utf8')}]`);
                return {
                    after,
                    inclusive,
                    idCursor,
                    value
                };
            }
        }
    }

}
