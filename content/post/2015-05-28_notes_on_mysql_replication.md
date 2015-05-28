---
comments: true
date: 2015-05-28T13:18:39+10:00
draft: false
image: ""
slug: clones-doppelgangers-threads-and-slaves
tags:
- mysql
- replication
title: "Clones, Doppelgängers, Threads and Slaves: Notes On MySQL Replication"
---

Notes on MySQL replication terminology, how to interpret the results of `SHOW SLAVE STATUS` and `SHOW MASTER STATUS`, and how to correctly configure new slave and master hosts in your MySQL clusters.

<!--more-->

To start, here's MySQL's own definition of the threads involved in replication:

> MySQL replication capabilities are implemented using three threads, one on the master server and two on the slave:

> **Binlog dump thread.**  The master creates a thread to send the binary log contents to a slave when the slave connects. This thread can be identified in the output of `SHOW PROCESSLIST` on the master as the Binlog Dump thread.
>
> The binary log dump thread acquires a lock on the master's binary log for reading each event that is to be sent to the slave. As soon as the event has been read, the lock is released, even before the event is sent to the slave.
>
> **Slave I/O thread.**  When a `START SLAVE` statement is issued on a slave server, the slave creates an I/O thread, which connects to the master and asks it to send the updates recorded in its binary logs.
>
> The slave I/O thread reads the updates that the master's Binlog Dump thread sends (see previous item) and copies them to local files that comprise the slave's relay log.
>
> The state of this thread is shown as `Slave_IO_running` in the output of `SHOW SLAVE STATUS` or as `Slave_running` in the output of `SHOW STATUS`.
>
> **Slave SQL thread.**  The slave creates an SQL thread to read the relay log that is written by the slave I/O thread and execute the events contained therein.

-- [MySQL 5.5 Reference Manual, 17.2.1 Replication Implementation Details](https://dev.mysql.com/doc/refman/5.5/en/replication-implementation-details.html)

`SHOW MASTER STATUS` tells us where the **Binlog dump thread** has written up to:

```no-highlight
root@db01 $ mysql -e 'SHOW MASTER STATUS\G'
*************************** 1. row ***************************
            File: master.014884
        Position: 968257120
    Binlog_Do_DB:
Binlog_Ignore_DB: monitor
```

If we cloned this server at this point and wanted the clone to slave off this
server, we should:

```
CHANGE MASTER TO MASTER_HOST='db01'
                 MASTER_LOG_FILE='$File'
                 MASTER_LOG_POS=$Position;
```

`SHOW SLAVE STATUS` can tell us -- amongst other things -- where the **Slave I/O and SQL threads** are up to:

```no-highlight
root@db02 $ mysql -e 'SHOW SLAVE STATUS\G'
*************************** 1. row ***************************
               Slave_IO_State: Waiting for master to send event
                  Master_Host: db01
                  Master_User: slave_user
                  Master_Port: 3306
                Connect_Retry: 60
              Master_Log_File: master.014884
          Read_Master_Log_Pos: 968223858
               Relay_Log_File: relay.000320
                Relay_Log_Pos: 968223335
        Relay_Master_Log_File: master.014884
             Slave_IO_Running: Yes
            Slave_SQL_Running: Yes
              Replicate_Do_DB:
          Replicate_Ignore_DB:
           Replicate_Do_Table:
       Replicate_Ignore_Table:
      Replicate_Wild_Do_Table:
  Replicate_Wild_Ignore_Table:
                   Last_Errno: 0
                   Last_Error:
                 Skip_Counter: 0
          Exec_Master_Log_Pos: 968223192
              Relay_Log_Space: 968224187
              Until_Condition: None
               Until_Log_File:
                Until_Log_Pos: 0
           Master_SSL_Allowed: No
           Master_SSL_CA_File:
           Master_SSL_CA_Path:
              Master_SSL_Cert:
            Master_SSL_Cipher:
               Master_SSL_Key:
        Seconds_Behind_Master: 0
Master_SSL_Verify_Server_Cert: No
                Last_IO_Errno: 0
                Last_IO_Error:
               Last_SQL_Errno: 0
               Last_SQL_Error:
  Replicate_Ignore_Server_Ids:
             Master_Server_Id: 1
```

The **Slave I/O thread** has read up to `Read_Master_Log_Pos` in `Master_Log_File` from `Master_Host`'s binlogs.

The **Slave SQL thread** has executed events up to `Exec_Master_Log_Pos` in `Relay_Master_Log_File` from `Master_Host`'s binlogs.

In theory, when `Seconds_Behind_Master` is `0`, all these values should line
up with the values from `SHOW MASTER STATUS` on `$Master_Host`.

If we create a clone of this slave, and want it to slave off the same `$Master_Host`, we should:

```sql
CHANGE MASTER TO MASTER_HOST='$Master_Host'
                 MASTER_LOG_FILE='$Relay_Master_Log_File'
                 MASTER_LOG_POS=$Exec_Master_Log_Pos;
```

All fairly simple so far.

So!

Let's say we have a slave `db02`.

![](/img/2015/05/graph_1.dot.png)

`db02` is happily slaving off its master, `db01`.

![](/img/2015/05/graph_2.dot.png)

But we want to shoot `db01` and replace it with a doppelgänger while `db02` is distracted! For reasons.

![](/img/2015/05/graph_3.dot.png)

So we clone `db01` as `new-db01`

![](/img/2015/05/graph_4.dot.png)

and set it up to slave off `db01`.

![](/img/2015/05/graph_5.dot.png)

Now the tricky bits:

1. Stop replication on `db02` -- we do this first as we want it to fall a little behind `db01` and `new-db`

    ```no-highlight
root@db02 $ mysql -e 'STOP SLAVE;'
root@db02 $ mysql -e 'SHOW SLAVE STATUS\G' | grep Running
             Slave_IO_Running: No
            Slave_SQL_Running: No
    ```

    ![](/img/2015/05/graph_6.dot.png)

3. Ensure that all writes that made it to `db01` are flushed to disk, and explicitly lock it against any further writes

    ```no-highlight
root@db01 $ mysql
mysql> FLUSH TABLES WITH READ LOCK;
    ```

    **N.B.** Leave this MySQL session running! "[If the connection for a client session terminates, whether normally or abnormally, the server implicitly releases all table locks held by the session](https://dev.mysql.com/doc/refman/5.5/en/lock-tables.html)", so if you close this session writes can resume.

3. Once `new-db01` is in sync with the stalled `db01`, stop replication on `new-db01`

    ```no-highlight
root@new-db01 # mysql -e 'STOP SLAVE;'
root@new-db01 # mysql -e 'SHOW SLAVE STATUS\G' | grep Running
             Slave_IO_Running: No
            Slave_SQL_Running: No
    ```

    ![](/img/2015/05/graph_7.dot.png)

4. Get the SQL thread state on `new-db01`

    ```no-highlight
root@new-db01 # mysql -e 'SHOW SLAVE STATUS\G' | grep -E "Exec_Master_Log_Pos|Relay_Master_Log_File"
        Relay_Master_Log_File: master.014891
          Exec_Master_Log_Pos: 184690632
    ```

5. Get the binlog thread state on `new-db01`

    ```no-highlight
root@new-db01 # mysql -e 'SHOW MASTER STATUS\G'
*************************** 1. row ***************************
            File: master.000115
        Position: 1073640720
    Binlog_Do_DB:
Binlog_Ignore_DB: monitor
    ```

    This gives us a pair of binlog coordinates on `db01` (from `SHOW SLAVE STATUS`) and `new-db01` that match.

6. Have `db02` resuming slaving off `db01` until it's caught up to the same point as `new-db01`

    ```no-highlight
root@db02 # mysql -e "START SLAVE UNTIL MASTER_LOG_FILE='$Relay_Master_Log_File', MASTER_LOG_POS=$Exec_Master_Log_Pos;"
root@db02 # mysql -e 'SHOW SLAVE STATUS\G' | grep -E "_Running|Until_"
             Slave_IO_Running: Yes
            Slave_SQL_Running: Yes
              Until_Condition: ?
               Until_Log_File: ?
                Until_Log_Pos: ?
    ```

    ![](/img/2015/05/graph_8.dot.png)

7. Stop replication on `db02`

    ```no-highlight
root@db02 # mysql -e 'STOP SLAVE;'
root@db02 # mysql -e 'SHOW SLAVE STATUS\G' | grep Running
             Slave_IO_Running: No
            Slave_SQL_Running: No
    ```

    ![](/img/2015/05/graph_9.dot.png)

8. Slave `db02` off `new-db01` starting at the end of `new-db01`'s binlogs (i.e. the `File` and `Position` values from `SHOW MASTER STATUS` above)

    ```no-highlight
root@db02 # mysql -e "CHANGE MASTER TO MASTER_HOST='new-db01', MASTER_LOG_FILE='$File', MASTER_LOG_POS=$Position;"
    ```

9. Start replication on `db02`

    ```no-highlight
root@db02 # mysql -e 'START SLAVE;'
    ```

    ![](/img/2015/05/graph_99.dot.png)

10. Check that replication on `db02` is happy

    ```no-highlight
root@db02 # mysql -e 'SHOW SLAVE STATUS\G'
    ```

11. Do all the other things that replace `db01` with `new-db01` -- update its hostname, its IP addresses, etc. etc. etc.

_Et voilà_, `db02` barely has to know that we killed and replaced its master.
