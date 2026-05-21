{
  "teacher": {
    "available_hours": [0, 60, 120, 180, 240],  // Στοιχεία ώρας σε λεπτά από την έναρξη της ημέρας (0:00 - 23:59)
    "home_address": "123 Teacher Street, City"
  },
  "students": [
    {
      "id": "S001",
      "address": "456 Student Avenue, Town",
      "service_time": 60,  // Διάρκεια του μαθήματος σε λεπτά
      "time_window": [300, 780]  // Χρονικό παράθυρο σε λεπτά από την έναρξη της ημέρας (0:05 - 13:00)
    },
    {
      "id": "S002",
      "address": "789 Student Lane, District",
      "service_time": 45,
      "time_window": [420, 720]  // Χρονικό παράθυρο σε λεπτά από την έναρξη της ημέρας (0:07 - 12:00)
    },
    {
      "id": "S003",
      "address": "101 Student Road, Suburb",
      "service_time": 90,
      "time_window": [540, 840]  // Χρονικό παράθυρο σε λεπτά από την έναρξη της ημέρας (0:09 - 14:00)
    },
    {
      "id": "S004",
      "address": "202 Student Place, Village",
      "service_time": 60,
      "time_window": [360, 780]  // Χρονικό παράθυρο σε λεπτά από την έναρξη της ημέρας (0:06 - 13:00)
    }
  ]
}

from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

def create_data_model():
    data = {}
    # Μηχανής διάρκειας του μαθήματος (service_time) σε λεπτά
    data['service_time'] = [0, 60, 45, 90, 60] 
    # Χρονικό παράθυρο κάθε μαθητή (time_window) σε λεπτά από την έναρξη της ημέρας
    data['time_windows'] = [
        (0, 1440), # Καθηγητής - Ο χρονικό παράθυρο του καθηγητή είναι η ολή η μέρα
        (300, 780), # Student S001
        (420, 720), # Student S002
        (540, 840), # Student S003
        (360, 780)  # Student S004
    ]
    # Μηχανής οδήγησης για κάθε τυχαίο μέτρο από τη βάση (5x5)
    data['distance_matrix'] = [
        [0, 18, 22, 34, 45],
        [18, 0, 17, 32, 50],
        [22, 17, 0, 39, 56],
        [34, 32, 39, 0, 24],
        [45, 50, 56, 24, 0]
    ]
    # Αρχικό και τελικό σημείο (καθηγητής)
    data['depot'] = 0
    return data

def print_solution(manager, routing, solution):
    """Prints solution on console."""
    print('Objective: {} miles'.format(solution.ObjectiveValue()))
    index = routing.Start(0)
    plan_output = 'Route for vehicle 0:\n'
    time_dimension = routing.GetDimensionOrDie('Time')
    while not routing.IsEnd(index):
        time_var = time_dimension.CumulVar(index)
        plan_output += '{0} Time({1},{2}) -> '.format(
            manager.IndexToNode(index), solution.Min(time_var),
            solution.Max(time_var))
        index = solution.Value(routing.NextVar(index))

    time_var = time_dimension.CumulVar(index)
    plan_output += '{0} Time({1},{2})\n'.format(manager.IndexToNode(index),
                                                 solution.Min(time_var),
                                                 solution.Max(time_var))
    print(plan_output)

def main():
    """Solve the VRP problem."""
    # Create the data model.
    data = create_data_model()

    # Create the routing index manager.
    manager = pywrapcp.RoutingIndexManager(len(data['distance_matrix']), 1, data['depot'])

    # Create Routing Model.
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index, to_index):
        """Returns the travel time between the two nodes."""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        return data['distance_matrix'][from_node][to_node]

    transit_callback_index = routing.RegisterTransitCallback(time_callback)

    # Define cost of each arc.
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    # Add Time Windows constraint.
    time = 'Time'
    routing.AddDimension(
        transit_callback_index,
        30,  # Slack
        1440,  # Maximum time per vehicle
        False,  # Don't force start cumul to zero.
        time)
    time_dimension = routing.GetDimensionOrDie(time)
    for location_idx, time_window in enumerate(data['time_windows']):
        if location_idx != data['depot']:
            index = manager.NodeToIndex(location_idx)
            time_dimension.CumulVar(index).SetRange(time_window[0], time_window[1])

    # Setting first solution heuristic.
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.time_limit.seconds = 5

    # Solve the problem.
    solution = routing.SolveWithParameters(search_parameters)

    # Print solution on console.
    if solution:
        print_solution(manager, routing, solution)
    else:
        print('No solution found!')

if __name__ == '__main__':
    main()
#**Εξηγήσεις:**
#(- Στον πίνακα `distance_matrix`, μπορείτε να βλέπετε τυχαίους χρόνους οδήγησης (σε λεπτά) ανάμεσα σε κάθε δύο 
#σημεία`service_time` είναι μια λίστα που περιλαμβάνει τη διάρκεια των μαθημάτων για κάθε μαθητή.
# Το `time_windows` είναι μια λίστα που περιλαμβάνει τα χρονικά παράθυρα για κάθε μαθητή (πρότυπο `(start, end)` 
#σε λεπτά).
# Στη μέθοδο `print_solution`, τυπώνονται ακριβείς ώρες άφιξης καθώς και το νομικό πλάνο για τον προσωπικό μαθητή.
# Ο `time_limit.seconds = 5` εγγυάται ότι ο solver δεν κολλάει αν δεν βρει λύση σε 5 δευτερόλεπτα.
#Αυτός ο κώδικας πρέπει να λύει το πρόβλημα VRPTW και να εμφανίζει το σχεδιασμένο ρυθμό για τη διάταξη των 
#μαθημάτων.)

